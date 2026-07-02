import { resolveClaudeBinary } from "../src/lib/launcher.js";
import { spawn } from "node:child_process";

const imagePath = "<your-jot-data-dir>/jot-images/152e01da-923d-4178-9ae7-573f35588fde/6342ca9c-ca9d-4357-b7ba-b3fbcb9b1de3.png";
const prompt = `There is a screenshot at this exact file path: ${imagePath}\nOpen it and tell me: which dropdown option is currently highlighted/selected (blue background), and list the other options in the dropdown, in order. Be precise, this is a factual check.`;

const claudePath = resolveClaudeBinary();
const child = spawn(claudePath, ["-p", prompt, "--output-format", "stream-json", "--verbose"], {
  cwd: process.cwd(),
  env: process.env,
});

let buf = "";
child.stdout.on("data", (c) => { buf += c.toString("utf8"); });
child.stderr.on("data", (c) => { process.stderr.write(c); });
child.on("close", () => {
  for (const line of buf.split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      if (evt.type === "assistant") {
        for (const b of evt.message?.content || []) {
          if (b.type === "text") console.log("ASSISTANT TEXT:", b.text);
          if (b.type === "tool_use") console.log("TOOL USE:", b.name, JSON.stringify(b.input));
        }
      }
    } catch {}
  }
});
