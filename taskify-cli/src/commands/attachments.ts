import chalk from "chalk";
import type { Command } from "commander";
import { writeFile } from "fs/promises";
import { decryptAttachmentToDataUrl } from "../attachmentCrypto.js";
import { loadConfig } from "../config.js";
import { renderJson } from "../render.js";
import type { CommandContext } from "./context.js";

export function registerAttachmentsCommands(program: Command, context: Pick<CommandContext, "initRuntime" | "resolveBoardId" | "extractDocumentUrl" | "resolveDocumentByRef">) {
  const { initRuntime, resolveBoardId, extractDocumentUrl, resolveDocumentByRef } = context;
  const attachmentCmd = program.command("attachment").description("Inspect, decrypt, and download task/event attachments");

  attachmentCmd
    .command("task-show <taskId> <attachmentRef>")
    .description("Alias for attachment show")
    .option("--board <id|name>", "Board the task belongs to")
    .option("--json", "Output attachment as JSON")
    .action(async (taskId: string, attachmentRef: string, opts) => {
      await program.parseAsync(["node", "taskify", "attachment", "show", taskId, attachmentRef, ...(opts.board ? ["--board", opts.board] : []), ...(opts.json ? ["--json"] : [])], { from: "user" });
    });

  attachmentCmd
    .command("task-download <taskId> <attachmentRef>")
    .description("Alias for attachment download")
    .option("--board <id|name>", "Board the task belongs to")
    .option("--out <path>", "Output path")
    .action(async (taskId: string, attachmentRef: string, opts) => {
      await program.parseAsync(["node", "taskify", "attachment", "download", taskId, attachmentRef, ...(opts.board ? ["--board", opts.board] : []), ...(opts.out ? ["--out", opts.out] : [])], { from: "user" });
    });

  attachmentCmd
    .command("show <taskId> <attachmentRef>")
    .description("Show a task attachment by 1-based index or partial name")
    .option("--board <id|name>", "Board the task belongs to")
    .option("--json", "Output attachment as JSON")
    .action(async (taskId: string, attachmentRef: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const boardId = await resolveBoardId(opts.board, config);
      const runtime = initRuntime(config);
      try {
        const task = await runtime.getTask(taskId, boardId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        const hit = resolveDocumentByRef(task.documents as Record<string, unknown>[] | undefined, attachmentRef);
        if (!hit) throw new Error(`Attachment not found: ${attachmentRef}`);
        if (opts.json) renderJson(hit.doc);
        else {
          const name = typeof hit.doc.name === "string" ? hit.doc.name : `document-${hit.index + 1}`;
          const mime = typeof hit.doc.mimeType === "string" ? hit.doc.mimeType : "application/octet-stream";
          const kind = typeof hit.doc.kind === "string" ? hit.doc.kind : "unknown";
          const remoteUrl = extractDocumentUrl(hit.doc);
          console.log(chalk.bold(name));
          console.log(`index: ${hit.index + 1}`);
          console.log(`kind: ${kind}`);
          console.log(`mime: ${mime}`);
          if (typeof hit.doc.encrypted === "boolean") console.log(`encrypted: ${hit.doc.encrypted}`);
          if (typeof hit.doc.encryptionBoardId === "string") console.log(`encryptionBoardId: ${hit.doc.encryptionBoardId}`);
          if (remoteUrl) console.log(`remoteUrl: ${remoteUrl}`);
        }
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally {
        await runtime.disconnect();
      }
    });

  attachmentCmd
    .command("download <taskId> <attachmentRef>")
    .description("Download a task attachment, decrypting if needed")
    .option("--board <id|name>", "Board the task belongs to")
    .option("--out <path>", "Output path")
    .action(async (taskId: string, attachmentRef: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const boardId = await resolveBoardId(opts.board, config);
      const runtime = initRuntime(config);
      try {
        const task = await runtime.getTask(taskId, boardId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        const hit = resolveDocumentByRef(task.documents as Record<string, unknown>[] | undefined, attachmentRef);
        if (!hit) throw new Error(`Attachment not found: ${attachmentRef}`);
        const name = typeof hit.doc.name === "string" ? hit.doc.name : `document-${hit.index + 1}`;
        const mime = typeof hit.doc.mimeType === "string" ? hit.doc.mimeType : "application/octet-stream";
        const outPath = opts.out || name;
        let dataUrl = typeof hit.doc.dataUrl === "string" ? hit.doc.dataUrl : "";
        const remoteUrl = extractDocumentUrl(hit.doc);
        if ((!dataUrl || dataUrl.startsWith("data:application/octet-stream;base64,")) && remoteUrl) {
          if (hit.doc.encrypted === true) {
            dataUrl = await decryptAttachmentToDataUrl(typeof hit.doc.encryptionBoardId === "string" ? hit.doc.encryptionBoardId : boardId, remoteUrl, mime);
          } else {
            const res = await fetch(remoteUrl);
            if (!res.ok) throw new Error(`Failed to fetch attachment (${res.status})`);
            const bytes = Buffer.from(await res.arrayBuffer());
            dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
          }
        }
        if (!dataUrl.startsWith("data:")) throw new Error("Attachment has no retrievable data.");
        const base64 = dataUrl.split(",", 2)[1] || "";
        await writeFile(outPath, Buffer.from(base64, "base64"));
        console.log(chalk.green(`✓ Saved attachment to ${outPath}`));
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally {
        await runtime.disconnect();
      }
    });

  attachmentCmd
    .command("event-show <eventId> <attachmentRef>")
    .description("Show an event attachment by 1-based index or partial name")
    .option("--board <id|name>", "Board the event belongs to")
    .option("--json", "Output attachment as JSON")
    .action(async (eventId: string, attachmentRef: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      try {
        const boardId = opts.board ? await resolveBoardId(opts.board, config) : undefined;
        const event = await runtime.getEvent(eventId, boardId);
        if (!event) throw new Error(`Event not found: ${eventId}`);
        const hit = resolveDocumentByRef(event.documents as Record<string, unknown>[] | undefined, attachmentRef);
        if (!hit) throw new Error(`Attachment not found: ${attachmentRef}`);
        if (opts.json) renderJson(hit.doc);
        else {
          const name = typeof hit.doc.name === "string" ? hit.doc.name : `document-${hit.index + 1}`;
          const mime = typeof hit.doc.mimeType === "string" ? hit.doc.mimeType : "application/octet-stream";
          const remoteUrl = extractDocumentUrl(hit.doc);
          console.log(chalk.bold(name));
          console.log(`index: ${hit.index + 1}`);
          console.log(`event: ${event.title}`);
          console.log(`mime: ${mime}`);
          if (typeof hit.doc.encrypted === "boolean") console.log(`encrypted: ${hit.doc.encrypted}`);
          if (typeof hit.doc.encryptionBoardId === "string") console.log(`encryptionBoardId: ${hit.doc.encryptionBoardId}`);
          if (remoteUrl) console.log(`remoteUrl: ${remoteUrl}`);
        }
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally {
        await runtime.disconnect();
      }
    });

  attachmentCmd
    .command("event-download <eventId> <attachmentRef>")
    .description("Download an event attachment, decrypting if needed")
    .option("--board <id|name>", "Board the event belongs to")
    .option("--out <path>", "Output path")
    .action(async (eventId: string, attachmentRef: string, opts) => {
      const config = await loadConfig(program.opts().profile as string | undefined);
      const runtime = initRuntime(config);
      try {
        const boardId = opts.board ? await resolveBoardId(opts.board, config) : undefined;
        const event = await runtime.getEvent(eventId, boardId);
        if (!event) throw new Error(`Event not found: ${eventId}`);
        const hit = resolveDocumentByRef(event.documents as Record<string, unknown>[] | undefined, attachmentRef);
        if (!hit) throw new Error(`Attachment not found: ${attachmentRef}`);
        const name = typeof hit.doc.name === "string" ? hit.doc.name : `document-${hit.index + 1}`;
        const mime = typeof hit.doc.mimeType === "string" ? hit.doc.mimeType : "application/octet-stream";
        const outPath = opts.out || name;
        let dataUrl = typeof hit.doc.dataUrl === "string" ? hit.doc.dataUrl : "";
        const remoteUrl = extractDocumentUrl(hit.doc);
        if ((!dataUrl || dataUrl.startsWith("data:application/octet-stream;base64,")) && remoteUrl) {
          if (hit.doc.encrypted === true) {
            dataUrl = await decryptAttachmentToDataUrl(typeof hit.doc.encryptionBoardId === "string" ? hit.doc.encryptionBoardId : event.boardId, remoteUrl, mime);
          } else {
            const res = await fetch(remoteUrl);
            if (!res.ok) throw new Error(`Failed to fetch attachment (${res.status})`);
            const bytes = Buffer.from(await res.arrayBuffer());
            dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
          }
        }
        if (!dataUrl.startsWith("data:")) throw new Error("Attachment has no retrievable data.");
        const base64 = dataUrl.split(",", 2)[1] || "";
        await writeFile(outPath, Buffer.from(base64, "base64"));
        console.log(chalk.green(`✓ Saved attachment to ${outPath}`));
        process.exit(0);
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally {
        await runtime.disconnect();
      }
    });

}
