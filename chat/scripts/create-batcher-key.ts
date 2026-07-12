import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Wallet } from "ethers";

const outputPath = resolve(process.argv[2] || "../.sepolia-batcher.key");
const wallet = Wallet.createRandom();

await writeFile(outputPath, `${wallet.privateKey}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});

// Never print the private key. The address and local file location are safe.
console.log(JSON.stringify({ address: wallet.address, keyFile: outputPath }));
