const captions = [
  "Tingyi Lite demo caption is connected.",
  "This line comes from the explicit demo helper.",
  "System captions remain the default product path.",
  "Use this mode only to test the UI and event pipeline."
];

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
});

console.log(JSON.stringify({ type: "status", ok: true, status: "ready", helper: "tingyi-lite-demo-caption-helper" }));

let index = 0;
const timer = setInterval(() => {
  const now = index * 2000;
  console.log(JSON.stringify({
    type: "caption",
    text: captions[index % captions.length],
    startMs: now,
    endMs: now + 1600,
    language: "en",
    isFinal: true
  }));
  index += 1;
}, 2000);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newlineIndex = input.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = input.slice(0, newlineIndex).trim();
    input = input.slice(newlineIndex + 1);
    newlineIndex = input.indexOf("\n");
    if (!line) {
      continue;
    }
    const message = JSON.parse(line);
    if (message?.type === "stop") {
      clearInterval(timer);
      process.exit(0);
    }
  }
});
process.stdin.resume();
