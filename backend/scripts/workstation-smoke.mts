/**
 * Mission 13 phase 1 smoke test: runs real commands in a workstation VM
 * through the harness's own exec library and prints what came back.
 *
 *   WORKSTATION_SSH_IDENTITY_FILE=~/.ssh/mike-workstation-dev \
 *     npx tsx scripts/workstation-smoke.mts [host] [port]
 */
import { runInWorkstation, type WorkstationTarget } from "../src/lib/workstation";

const target: WorkstationTarget = {
  host: process.argv[2] ?? "127.0.0.1",
  port: Number(process.argv[3] ?? 2222),
  user: "agent",
  identityFile: process.env.WORKSTATION_SSH_IDENTITY_FILE ?? "",
};

const steps: Array<[string, string]> = [
  ["who and where", "id && uname -srm && pwd && df -h /home | tail -1"],
  ["tools", "python3 --version && node --version && git --version"],
  ["write a Word document", `python3 - <<'PY'
from docx import Document
doc = Document()
doc.add_heading("Workstation smoke test", 1)
doc.add_paragraph("Written by python-docx inside the workstation VM.")
doc.save("smoke.docx")
PY
ls -l smoke.docx`],
  ["edit it and read it back", `python3 - <<'PY'
from docx import Document
doc = Document("smoke.docx")
doc.paragraphs[1].text = doc.paragraphs[1].text.replace("Written", "Edited")
doc.save("smoke.docx")
print([p.text for p in Document("smoke.docx").paragraphs])
PY`],
  ["a spreadsheet", `python3 -c "import openpyxl; wb = openpyxl.Workbook(); ws = wb.active; ws.append(['a', 'b']); ws.append([2, 3]); ws['C2'] = '=A2*B2'; wb.save('smoke.xlsx'); print(openpyxl.load_workbook('smoke.xlsx').active['C2'].value)"`],
  ["a failing command", "cat /does/not/exist"],
  ["no root", "sudo true; echo exit=$?"],
  ["a timeout", "sleep 30"],
];

for (const [name, command] of steps) {
  const result = await runInWorkstation(target, { command, timeoutMs: name === "a timeout" ? 3000 : 60_000 });
  console.log(`\n## ${name}\n$ ${command.split("\n")[0]}${command.includes("\n") ? " ..." : ""}`);
  console.log(JSON.stringify(result, null, 2));
}
