import { hexToBytes } from "@noble/hashes/utils.js";
import type { Command } from "commander";
import { getPublicKey } from "nostr-tools";
import { loadConfig,saveConfig } from "../config.js";
import { findAccountCatalogBackup } from "../shared/accountBackup.js";
import { agentSuccess,writeAgentJson } from "../shared/agentOutput.js";
import { applyAccountCatalogBackup,mergeBoardsFromShareInbox } from "../shared/backupSync.js";
import { resolveCliLocation } from "../shared/cliLocation.js";
import {
createCliNostrSession,
FileNostrOutboxStore
} from "../shared/nodeRuntimeSession.js";
import { fetchShareInboxNip17 } from "../shared/shareTransport.js";
import type { CommandContext,CoreErrorDetails } from "./context.js";

export function registerDiscoveryCommands(program: Command, context: Pick<CommandContext, "initRuntime" | "useHumanOutput" | "CliCommandError" | "commandErrorDetails" | "writeCoreFailure" | "profilePubkey">) {
  const { initRuntime, useHumanOutput, CliCommandError, commandErrorDetails, writeCoreFailure, profilePubkey } = context;
  // ---- agent-first discovery and diagnostics ----
  program
    .command("context")
    .description("Describe the active profile, boards, lists, defaults, and core agent commands")
    .option("--human", "Render readable text instead of JSON")
    .action(async (opts: { human?: boolean }) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const identity = profilePubkey(config);
      const defaultBoard = config.defaultLocation
        ? config.boards.find((board) => board.id === config.defaultLocation?.boardId)
        : undefined;
      const defaultList = defaultBoard && config.defaultLocation?.listId
        ? defaultBoard.columns?.find((list) => list.id === config.defaultLocation?.listId)
        : undefined;
      let effectiveLocation: ReturnType<typeof resolveCliLocation> | null = null;
      let effectiveLocationError: CoreErrorDetails | null = null;
      try {
        effectiveLocation = resolveCliLocation(config, { intent: "write" });
      } catch (error) {
        effectiveLocationError = commandErrorDetails(error);
      }
      const data = {
        profile: {
          name: config.selectedProfile,
          active: config.selectedProfile === config.activeProfile,
          npub: identity?.npub ?? null,
          configured: Boolean(identity),
        },
        hierarchy: "profile > board > list > task",
        defaultLocation: config.defaultLocation
          ? {
              boardId: config.defaultLocation.boardId,
              boardName: defaultBoard?.name ?? null,
              listId: config.defaultLocation.listId ?? null,
              listName: defaultList?.name ?? null,
              path: defaultBoard
                ? `${defaultBoard.name}${defaultList ? `/${defaultList.name}` : ""}`
                : null,
            }
          : null,
        effectiveWriteLocation: effectiveLocation
          ? { ...effectiveLocation, path: `${effectiveLocation.boardName}${effectiveLocation.listName ? `/${effectiveLocation.listName}` : ""}` }
          : null,
        locationError: effectiveLocationError
          ? {
              code: effectiveLocationError.code,
              message: effectiveLocationError.message,
              details: effectiveLocationError.details,
            }
          : null,
        boards: config.boards.map((board) => ({
          id: board.id,
          name: board.name,
          kind: board.kind ?? "lists",
          visible: !board.archived && !board.hidden,
          writable: board.kind !== "compound" && !board.archived && !board.hidden,
          archived: Boolean(board.archived),
          hidden: Boolean(board.hidden),
          relays: board.relays?.length ? board.relays : config.relays,
          lists: (board.columns ?? []).map((list) => ({ id: list.id, name: list.name, path: `${board.name}/${list.name}` })),
        })),
        commands: {
          sync: "taskify sync",
          add: "taskify add \"Task title\" --in \"Board/List\" --idempotency-key <stable-key>",
          list: "taskify list --in \"Board/List\" --mine",
          done: "taskify done <task-id>",
          doctor: "taskify doctor",
        },
      };

      if (!useHumanOutput(opts)) {
        writeAgentJson(agentSuccess("context", data, { profile: config.selectedProfile }));
        return;
      }
      console.log(`Profile: ${data.profile.name} (${data.profile.npub ?? "identity not configured"})`);
      console.log(`Destination: ${data.effectiveWriteLocation?.path ?? data.locationError?.message ?? "not set"}`);
      for (const board of data.boards) {
        console.log(`${board.writable ? "" : "[read-only] "}${board.name}  ${board.id}`);
        for (const list of board.lists) console.log(`  ${list.name}  ${list.id}`);
      }
    });

  program
    .command("sync")
    .description("Discover the account board catalog and refresh board/list metadata")
    .option("--catalog-only", "Skip per-board metadata refresh")
    .option("--human", "Render readable text instead of JSON")
    .action(async (opts: { catalogOnly?: boolean; human?: boolean }) => {
      const command = "sync";
      const config = await loadConfig(program.opts().profile as string | undefined);
      let session: ReturnType<typeof createCliNostrSession>["session"] | null = null;
      try {
        const transport = createCliNostrSession(config, { verbose: Boolean(program.opts().verbose) });
        if (!transport.secretKeyHex) {
          throw new CliCommandError("CONFIG_INVALID", "No valid nsec is configured for the active profile.");
        }
        session = transport.session;
        await session.init(transport.relays);
        const pubkey = getPublicKey(hexToBytes(transport.secretKeyHex));
        const backup = await findAccountCatalogBackup({
          session,
          pubkey,
          secretKeyHex: transport.secretKeyHex,
          relays: transport.relays,
        });
        const account = backup
          ? applyAccountCatalogBackup(config, backup)
          : {
              backupFound: false as const,
              backupEventId: null,
              boardsBefore: config.boards.length,
              boardsAfter: config.boards.length,
              boardsAdded: 0,
              relaysBefore: config.relays.length,
              relaysAfter: config.relays.length,
            };
        let boardShares = { sharesScanned: 0, boardSharesFound: 0, boardsAdded: 0 };
        if (!backup) {
          const inbox = await fetchShareInboxNip17({
            recipientSecretHex: transport.secretKeyHex,
            relays: transport.relays,
            limit: 100,
          });
          boardShares = mergeBoardsFromShareInbox(config, inbox);
        }
        if (backup || boardShares.boardsAdded > 0) await saveConfig(config);
        await session.shutdown();
        session = null;

        const boardResults: Array<{ boardId: string; name: string; ok: boolean; lists: number; error?: string }> = [];
        if (!opts.catalogOnly && config.boards.length > 0) {
          const runtime = initRuntime(config);
          try {
            await Promise.all(config.boards.map(async (board) => {
              try {
                const metadata = await runtime.syncBoard(board.id);
                boardResults.push({
                  boardId: board.id,
                  name: metadata.name ?? board.name,
                  ok: true,
                  lists: metadata.columns?.length ?? board.columns?.length ?? 0,
                });
              } catch (error) {
                boardResults.push({
                  boardId: board.id,
                  name: board.name,
                  ok: false,
                  lists: board.columns?.length ?? 0,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }));
          } finally {
            await runtime.disconnect();
          }
        }
        boardResults.sort((left, right) => left.name.localeCompare(right.name));
        const ready = config.boards.some((board) => !board.archived && !board.hidden);
        const nextActions = ready
          ? []
          : [
              "Publish account sync once from Taskify PWA, then rerun `taskify sync`.",
              "Or join a known board with `taskify board join <board-id> --name <name>` or receive a Taskify board share.",
            ];
        const data = { ready, account, boardShares, boards: boardResults, nextActions };
        if (!useHumanOutput(opts)) {
          writeAgentJson(agentSuccess(command, data, { profile: config.selectedProfile }));
          return;
        }
        if (account.backupFound) {
          console.log(`Account catalog synced (${account.boardsAdded} board(s) added).`);
        } else if (boardShares.boardSharesFound > 0) {
          console.log(`No account backup found; imported ${boardShares.boardsAdded} board(s) from encrypted shares.`);
        } else {
          console.log("Sync connected, but this identity has no published account catalog or board shares.");
        }
        for (const board of boardResults) {
          console.log(`${board.ok ? "✓" : "✗"} ${board.name} (${board.lists} lists)`);
        }
        for (const action of nextActions) console.log(`Next: ${action}`);
      } catch (error) {
        process.exitCode = writeCoreFailure(command, error, useHumanOutput(opts));
      } finally {
        await session?.shutdown().catch(() => undefined);
      }
    });

  program
    .command("doctor")
    .description("Check identity, defaults, relay connectivity, and queued writes")
    .option("--human", "Render readable text instead of JSON")
    .action(async (opts: { human?: boolean }) => {
      const command = "doctor";
      const config = await loadConfig(program.opts().profile as string | undefined);
      let session: ReturnType<typeof createCliNostrSession>["session"] | null = null;
      try {
        const identity = profilePubkey(config);
        let defaultCheck: { ok: boolean; message: string };
        try {
          const location = resolveCliLocation(config, { intent: "read" });
          defaultCheck = { ok: true, message: `${location.boardName}${location.listName ? `/${location.listName}` : ""}` };
        } catch (error) {
          defaultCheck = { ok: false, message: error instanceof Error ? error.message : String(error) };
        }

        const transport = createCliNostrSession(config, { verbose: Boolean(program.opts().verbose) });
        session = transport.session;
        await session.init(transport.relays);
        const relays = session.relayStatuses();
        const queuedWrites = (await new FileNostrOutboxStore().listPending()).length;
        const checks = {
          identity: { ok: Boolean(identity), npub: identity?.npub ?? null },
          catalog: { ok: config.boards.length > 0, boards: config.boards.length },
          defaultLocation: defaultCheck,
          relays: {
            ok: relays.some((relay) => relay.connected),
            connected: relays.filter((relay) => relay.connected).length,
            total: relays.length,
            entries: relays,
          },
          outbox: { ok: queuedWrites === 0, queuedWrites },
        };
        const healthy = checks.identity.ok && checks.catalog.ok && checks.defaultLocation.ok && checks.relays.ok;
        if (!useHumanOutput(opts)) {
          writeAgentJson(agentSuccess(command, { healthy, checks }, { profile: config.selectedProfile }));
        } else {
          console.log(`${healthy ? "✓" : "✗"} Taskify CLI ${healthy ? "is ready" : "needs attention"}`);
          console.log(`${checks.identity.ok ? "✓" : "✗"} identity`);
          console.log(`${checks.catalog.ok ? "✓" : "✗"} catalog (${checks.catalog.boards} boards)`);
          console.log(`${checks.defaultLocation.ok ? "✓" : "✗"} default (${checks.defaultLocation.message})`);
          console.log(`${checks.relays.ok ? "✓" : "✗"} relays (${checks.relays.connected}/${checks.relays.total} connected)`);
          console.log(`${checks.outbox.ok ? "✓" : "!"} outbox (${queuedWrites} queued)`);
        }
        if (!healthy) process.exitCode = 1;
      } catch (error) {
        process.exitCode = writeCoreFailure(command, error, useHumanOutput(opts));
      } finally {
        await session?.shutdown().catch(() => undefined);
      }
    });

}
