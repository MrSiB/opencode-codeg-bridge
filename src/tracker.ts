import crypto from "node:crypto";
import type { SqliteClient } from "./sqlite.js";
import {
  findConversationByExternalId,
  createChildConversation,
  updateConversationExternalId,
  updateConversationStatus,
  reconcileStaleSubagents
} from "./tracker-db.js";
import type { ActiveDelegation, SubagentTrackerOptions } from "./types.js";
import { isSqliteBusyError, retryAsync } from "./retry.js";

export type { SubagentTrackerOptions };

export const DEFAULT_TRACKER_TIMEOUT_MS = 3000;
export const DEFAULT_TRACKER_MAX_AGE_MS = 3600000; // 1 hour
export const DEFAULT_TRACKER_PRUNE_INTERVAL_MS = 300000; // 5 minutes

export interface Logger {
  info?(message: string, ...args: any[]): void;
  warn?(message: string, ...args: any[]): void;
  error?(message: string, ...args: any[]): void;
  debug?(message: string, ...args: any[]): void;
}

export interface HandleToolBeforeInput {
  tool: string; sessionID: string; callID: string; args: any;
}
export interface HandleSessionCreatedInput {
  id: string; parentID?: string; title?: string;
}
export interface HandleToolAfterInput {
  tool: string; sessionID: string; callID: string; args: any; output: any; metadata?: any;
}

export class SubagentTracker {
  private client: SqliteClient;
  private logger?: Logger;
  private options: Required<SubagentTrackerOptions>;
  private cleanupTimer?: NodeJS.Timeout;
  public activeDelegations: Map<string, ActiveDelegation>;

  constructor(client: SqliteClient, logger?: Logger, options?: SubagentTrackerOptions) {
    this.client = client;
    this.logger = logger;
    this.options = {
      timeoutMs: options?.timeoutMs ?? DEFAULT_TRACKER_TIMEOUT_MS,
      maxAgeMs: options?.maxAgeMs ?? DEFAULT_TRACKER_MAX_AGE_MS,
      pruneIntervalMs: options?.pruneIntervalMs ?? DEFAULT_TRACKER_PRUNE_INTERVAL_MS
    };
    this.activeDelegations = new Map<string, ActiveDelegation>();

    if (this.options.pruneIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        try {
          this.pruneAbandoned();
        } catch (err) {
          this.logger?.error?.(
            `[SubagentTracker] Periodic prune failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }, this.options.pruneIntervalMs);
      this.cleanupTimer.unref?.();
    }
  }

  public dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  public pruneAbandoned(maxAgeMs?: number): number {
    const maxAge = maxAgeMs ?? this.options.maxAgeMs;
    const now = Date.now();
    let prunedCount = 0;
    for (const [callId, delegation] of this.activeDelegations.entries()) {
      if (now - delegation.startedAt > maxAge) {
        this.activeDelegations.delete(callId);
        prunedCount++;
        this.logger?.debug?.(
          `[SubagentTracker] Pruned abandoned delegation: callId=${callId}, age=${now - delegation.startedAt}ms`
        );
      }
    }
    return prunedCount;
  }

  private async executeDbOp<T>(opName: string, op: () => Promise<T>): Promise<T> {
    const timeoutMs = this.options.timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`[SubagentTracker] Operation '${opName}' timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    });

    const opPromise = retryAsync(op, {
      maxAttempts: 5,
      minDelayMs: 50,
      maxDelayMs: 500,
      shouldRetry: isSqliteBusyError
    });

    opPromise.catch((err) => {
      this.logger?.debug?.(
        `[SubagentTracker] Suppressed background error for '${opName}': ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });

    try {
      return await Promise.race([opPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public async handleToolBefore(input: HandleToolBeforeInput): Promise<void> {
    try {
      if (!input || (input.tool !== "task" && input.tool !== "delegate_to_agent")) {
        return;
      }

      const delegationCallId = crypto.randomUUID();
      const parentSessionId = input.sessionID;
      const callId = input.callID;

      let resolveRecordId!: (id: number | null) => void;
      const recordIdPromise = new Promise<number | null>((resolve) => {
        resolveRecordId = resolve;
      });

      let isResolved = false;
      const safeResolveRecordId = (id: number | null) => {
        if (!isResolved) {
          isResolved = true;
          resolveRecordId(id);
        }
      };

      const activeDelegation: ActiveDelegation = {
        callId, parentSessionId, recordIdPromise, startedAt: Date.now()
      };

      this.activeDelegations.set(callId, activeDelegation);

      // Async barrier / background resolution:
      (async () => {
        try {
          const parentConv = await this.executeDbOp("findConversationByExternalId", () =>
            findConversationByExternalId(this.client, parentSessionId)
          );
          if (!parentConv) {
            this.logger?.warn?.(
              `[SubagentTracker] Parent conversation not found for external ID: ${parentSessionId}`
            );
            safeResolveRecordId(null);
            return;
          }

          activeDelegation.parentConversationId = parentConv.id;
          activeDelegation.folderId = parentConv.folder_id;

          const title = input.args?.description ||
            (input.args?.prompt ? String(input.args.prompt).slice(0, 80) : undefined) ||
            (input.args?.task ? String(input.args.task).slice(0, 80) : undefined) ||
            "Subagent Task";
          const rawAgent = input.args?.subagent_type || input.args?.agent_type;
          const agentType = typeof rawAgent === "string" ? rawAgent : "open_code";

          const recordId = await this.executeDbOp("createChildConversation", () =>
            createChildConversation(this.client, {
              folderId: parentConv.folder_id,
              title,
              parentId: parentConv.id,
              parentToolUseId: callId,
              delegationCallId,
              kind: "delegate",
              agentType
            })
          );

          safeResolveRecordId(recordId);
        } catch (err) {
          this.logger?.error?.(
            `[SubagentTracker] Failed in background conversation creation: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          safeResolveRecordId(null);
        }
      })();
    } catch (err) {
      this.logger?.error?.(
        `[SubagentTracker] Error in handleToolBefore: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  public async handleSessionCreated(info: HandleSessionCreatedInput): Promise<void> {
    try {
      if (!info || !info.parentID) {
        return;
      }

      let matchedDelegation: ActiveDelegation | undefined;
      for (const delegation of this.activeDelegations.values()) {
        if (delegation.parentSessionId === info.parentID && !delegation.childSessionId) {
          matchedDelegation = delegation;
          break;
        }
      }

      if (!matchedDelegation) {
        return;
      }

      matchedDelegation.childSessionId = info.id;
      const recordId = await matchedDelegation.recordIdPromise;
      if (recordId !== null && recordId !== undefined) {
        await this.executeDbOp("updateConversationExternalId", () =>
          updateConversationExternalId(this.client, recordId!, info.id)
        );
      }
    } catch (err) {
      this.logger?.error?.(
        `[SubagentTracker] Error in handleSessionCreated: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  public async handleToolAfter(input: HandleToolAfterInput): Promise<void> {
    try {
      if (!input || (input.tool !== "task" && input.tool !== "delegate_to_agent")) {
        return;
      }

      const delegation = this.activeDelegations.get(input.callID);
      if (!delegation) {
        return;
      }

      try {
        const recordId = await delegation.recordIdPromise;
        if (recordId !== null && recordId !== undefined) {
          const isFailure = Boolean(
            input.metadata?.error ||
            (typeof input.output === "object" && input.output !== null && input.output.error) ||
            (typeof input.output === "string" && input.output.startsWith("Error:"))
          );

          const targetStatus = isFailure ? "failed" : "completed";
          await this.executeDbOp("updateConversationStatus", () =>
            updateConversationStatus(this.client, recordId!, targetStatus)
          );
        }
      } catch (innerErr) {
        this.logger?.error?.(
          `[SubagentTracker] Failed to update status in handleToolAfter: ${
            innerErr instanceof Error ? innerErr.message : String(innerErr)
          }`
        );
      } finally {
        this.activeDelegations.delete(input.callID);
      }
    } catch (err) {
      this.logger?.error?.(
        `[SubagentTracker] Error in handleToolAfter: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  public async reconcileStaleSubagents(olderThanMinutes?: number): Promise<number> {
    try {
      return await reconcileStaleSubagents(this.client, olderThanMinutes);
    } catch (err) {
      this.logger?.error?.(
        `[SubagentTracker] Error in reconcileStaleSubagents: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return 0;
    }
  }
}
