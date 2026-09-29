import crypto from "node:crypto";
import type { SqliteClient } from "./sqlite.js";
import {
  findConversationByExternalId,
  createChildConversation,
  updateConversationExternalId,
  updateConversationStatus
} from "./tracker-db.js";
import type { ActiveDelegation } from "./types.js";

export interface Logger {
  info?(message: string, ...args: any[]): void;
  warn?(message: string, ...args: any[]): void;
  error?(message: string, ...args: any[]): void;
  debug?(message: string, ...args: any[]): void;
}

export interface HandleToolBeforeInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: any;
}

export interface HandleSessionCreatedInput {
  id: string;
  parentID?: string;
  title?: string;
}

export interface HandleToolAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: any;
  output: any;
  metadata?: any;
}

export class SubagentTracker {
  private client: SqliteClient;
  private logger?: Logger;
  public activeDelegations: Map<string, ActiveDelegation>;

  constructor(client: SqliteClient, logger?: Logger) {
    this.client = client;
    this.logger = logger;
    this.activeDelegations = new Map<string, ActiveDelegation>();
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

      const activeDelegation: ActiveDelegation = {
        callId,
        parentSessionId,
        recordIdPromise,
        startedAt: Date.now()
      };

      this.activeDelegations.set(callId, activeDelegation);

      // Async barrier / background resolution:
      (async () => {
        try {
          const parentConv = await findConversationByExternalId(this.client, parentSessionId);
          if (!parentConv) {
            this.logger?.warn?.(
              `[SubagentTracker] Parent conversation not found for external ID: ${parentSessionId}`
            );
            resolveRecordId(null);
            return;
          }

          activeDelegation.parentConversationId = parentConv.id;
          activeDelegation.folderId = parentConv.folder_id;

          const title =
            input.args?.description ||
            (input.args?.prompt
              ? String(input.args.prompt).slice(0, 80)
              : input.args?.task
              ? String(input.args.task).slice(0, 80)
              : "Subagent Task");

          const agentType = input.args?.subagent_type || input.args?.agent_type || "open_code";

          const recordId = await createChildConversation(this.client, {
            folderId: parentConv.folder_id,
            title,
            parentId: parentConv.id,
            parentToolUseId: callId,
            delegationCallId,
            kind: "delegate",
            agentType: typeof agentType === "string" ? agentType : "open_code"
          });

          resolveRecordId(recordId);
        } catch (err) {
          this.logger?.error?.(
            `[SubagentTracker] Failed in background conversation creation: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          resolveRecordId(null);
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

      // Match delegation where delegation.parentSessionId === info.parentID
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
        await updateConversationExternalId(this.client, recordId, info.id);
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
          const isFailure =
            input.metadata?.error ||
            (typeof input.output === "object" && input.output !== null && input.output.error) ||
            (typeof input.output === "string" && input.output.startsWith("Error:"));

          const targetStatus = isFailure ? "failed" : "completed";
          await updateConversationStatus(this.client, recordId, targetStatus);
        }
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
}
