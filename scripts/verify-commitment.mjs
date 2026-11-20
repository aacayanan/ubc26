/**
 * F20 — verify a wager commitment against Solana Devnet, from the terminal.
 *
 *   cd apps/web
 *   npx tsx --conditions=react-server --env-file=.env.local --tsconfig tsconfig.json \
 *     ../../scripts/verify-commitment.mjs --signature <tx signature>
 *   # or:  --wager <wager uuid>     add --json for machine-readable output
 *
 * Runs exactly the checks the in-app "Verify on Devnet" panel runs (they share
 * lib/server/services/wagering/verify.ts): the transaction is on Devnet and
 * succeeded, the account's wallet signed it, the memo is the commitment hash
 * and nothing else, the treasury received the wagered SOL, the block time
 * beats the round's deadline, and the stored pick + nonce re-hash to the
 * committed hash.
 *
 * It reads the stored preimage with the service role, so it is an operator /
 * demo tool; a user verifies their own wager in the app. Read-only: it signs
 * and writes nothing. Exits 0 when every check passes, 1 otherwise.
 *
 * Proves inclusion and timing only — not that models, judging or settlement
 * were run honestly.
 */
import { verifyWagerCommitment } from "@/lib/server/services/wagering/verify";

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--json") args.json = true;
    else if (flag === "--signature") args.signature = argv[(i += 1)];
    else if (flag === "--wager") args.wagerId = argv[(i += 1)];
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

const usage =
  "usage: verify-commitment.mjs (--signature <sig> | --wager <uuid>) [--json]";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.signature && !args.wagerId)) {
    console.log(usage);
    process.exit(args.help ? 0 : 2);
  }

  const result = await verifyWagerCommitment({
    signature: args.signature,
    wagerId: args.wagerId,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `\nWager      ${result.wagerId} (${result.kind}, ${result.status})`,
    );
    console.log(`Round      ${result.roundId}`);
    console.log(`Signature  ${result.signature}`);
    console.log(`Explorer   ${result.explorerUrl}`);
    console.log(`Memo       ${result.memo}`);
    console.log(
      `Boundary   ${result.boundary.label}: ${result.boundary.at ?? "still open"} (+${result.boundary.graceSeconds}s landing window)`,
    );
    console.log(`Block time ${result.blockTime ?? "none"}\n`);
    for (const check of result.checks) {
      console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.label}`);
      console.log(`        ${check.detail}`);
    }
    console.log(`\n${result.verified ? "VERIFIED" : "NOT VERIFIED"}`);
    console.log(`${result.scope}\n`);
  }

  process.exit(result.verified ? 0 : 1);
}

main().catch((error) => {
  console.error(`verify-commitment: ${error?.message ?? error}`);
  process.exit(2);
});
