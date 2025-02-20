import { Worker, isMainThread } from "worker_threads";
import { Wallet, JsonRpcProvider, ethers } from "ethers";
import fs from "fs";
import { fileURLToPath } from "url";

const THREADS = 50

const provider = new JsonRpcProvider("https://ethereum-rpc.publicnode.com");

async function generateAndCheckWallet() {
    const wallet = Wallet.createRandom();
    const balance = await provider.getBalance(wallet.address);
    if (balance > 0n) {
        const walletData = `Address: ${wallet.address} | PrivateKey: ${wallet.privateKey} | Balance: ${ethers.formatEther(balance)} ETH\n`;
        console.log(`FOUND WALLET WITH BALANCE = ${walletData}`);
        fs.appendFileSync("wallets.txt", walletData);
    }else{
        const walletData = `${ethers.formatEther(balance)} ETH | ${wallet.address} | ${wallet.privateKey}`;
        console.log(walletData)
    }
}
if (isMainThread) {
    console.log(`START ${THREADS} threads...`);
    const __filename = fileURLToPath(import.meta.url);
    for (let i = 0; i < THREADS; i++) {
        new Worker(__filename);
    }
} else {
    (async () => {
        while (true) {
            await generateAndCheckWallet();
        }
    })();
}