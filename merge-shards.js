const fs = require('fs');

function usage() {
  console.error('Usage: node merge-shards.js <in1.csv> <in2.csv> <in3.csv> <out.csv>');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length !== 4) usage();

const [in1, in2, in3, out] = args;
const inputs = [in1, in2, in3];

let header = null;
let output = '';

for (let i = 0; i < inputs.length; i += 1) {
  const p = inputs[i];
  if (!fs.existsSync(p)) {
    console.warn(`Missing shard file: ${p}`);
    continue;
  }

  const text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n').filter(Boolean);
  if (lines.length === 0) continue;

  if (!header) {
    header = lines[0];
    output += header + '\n';
  }

  const start = lines[0] === header ? 1 : 0;
  for (let j = start; j < lines.length; j += 1) {
    output += lines[j] + '\n';
  }
}

fs.writeFileSync(out, output, 'utf8');
console.log(`Merged file written: ${out}`);
