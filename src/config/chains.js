const ZERO_EX_CHAINS = new Map([
  [1, "ethereum"],
  [10, "optimism"],
  [56, "bnb"],
  [130, "unichain"],
  [137, "polygon"],
  [143, "monad"],
  [146, "sonic"],
  [480, "world-chain"],
  [999, "hyperevm"],
  [2741, "abstract"],
  [4217, "tempo"],
  [5000, "mantle"],
  [9745, "plasma"],
  [42161, "arbitrum"],
  [43114, "avalanche"],
  [4663, "robinhood"],
  [5042, "arc"],
  [534352, "scroll"],
  [57073, "ink"],
  [59144, "linea"],
  [80094, "berachain"],
  [8453, "base"]
]);

const SOURCE_CHAINS = [
  ["ethereum", "Ethereum", 1, "ETH", 18, ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"], "https://etherscan.io", ["eth", "mainnet"]],
  ["polygon", "Polygon", 137, "POL", 18, ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"], "https://polygonscan.com", ["matic"]],
  ["base", "Base", 8453, "ETH", 18, ["https://base-rpc.publicnode.com", "https://mainnet.base.org"], "https://basescan.org", []],
  ["arbitrum", "Arbitrum One", 42161, "ETH", 18, ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"], "https://arbiscan.io", ["arbitrum-one"]],
  ["arbitrum-nova", "Arbitrum Nova", 42170, "ETH", 18, ["https://nova.arbitrum.io/rpc", "https://arbitrum-nova-rpc.publicnode.com"], "https://nova.arbiscan.io", ["nova"]],
  ["optimism", "OP Mainnet", 10, "ETH", 18, ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io"], "https://optimistic.etherscan.io", ["op"]],
  ["avalanche", "Avalanche C-Chain", 43114, "AVAX", 18, ["https://avalanche-c-chain-rpc.publicnode.com", "https://api.avax.network/ext/bc/C/rpc"], "https://snowtrace.io", ["avax"]],
  ["bnb", "BNB Smart Chain", 56, "BNB", 18, ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org"], "https://bscscan.com", ["bsc"]],
  ["blast", "Blast", 81457, "ETH", 18, ["https://blast-rpc.publicnode.com", "https://rpc.blast.io"], "https://blastscan.io", []],
  ["zora", "Zora", 7777777, "ETH", 18, ["https://rpc.zora.energy", "https://zora.drpc.org"], "https://explorer.zora.energy", []],
  ["sei", "Sei", 1329, "SEI", 18, ["https://evm-rpc.sei-apis.com", "https://sei.drpc.org"], "https://seitrace.com", []],
  ["b3", "B3", 8333, "ETH", 18, ["https://mainnet-rpc.b3.fun/http"], "https://explorer.b3.fun", []],
  ["berachain", "Berachain", 80094, "BERA", 18, ["https://rpc.berachain.com", "https://berachain-rpc.publicnode.com"], "https://berascan.com", ["bera"]],
  ["flow", "Flow EVM", 747, "FLOW", 18, ["https://mainnet.evm.nodes.onflow.org", "https://flow.drpc.org"], "https://evm.flowscan.io", ["flow-evm"]],
  ["apechain", "ApeChain", 33139, "APE", 18, ["https://apechain.calderachain.xyz/http", "https://apechain.drpc.org"], "https://apescan.io", ["ape-chain"]],
  ["soneium", "Soneium", 1868, "ETH", 18, ["https://rpc.soneium.org", "https://soneium.drpc.org"], "https://soneium.blockscout.com", []],
  ["shape", "Shape", 360, "ETH", 18, ["https://mainnet.shape.network"], "https://shapescan.xyz", []],
  ["unichain", "Unichain", 130, "ETH", 18, ["https://mainnet.unichain.org", "https://unichain-rpc.publicnode.com"], "https://uniscan.xyz", []],
  ["ronin", "Ronin", 2020, "RON", 18, ["https://api.roninchain.com/rpc", "https://ronin.drpc.org"], "https://app.roninchain.com", []],
  ["abstract", "Abstract", 2741, "ETH", 18, ["https://api.mainnet.abs.xyz", "https://abstract.drpc.org"], "https://abscan.org", []],
  ["hyperevm", "HyperEVM", 999, "HYPE", 18, ["https://rpc.hyperliquid.xyz/evm"], "https://hyperevmscan.io", ["hyperliquid"]],
  ["somnia", "Somnia", 5031, "SOMI", 18, ["https://api.infra.mainnet.somnia.network"], "https://explorer.somnia.network", []],
  ["megaeth", "MegaETH", 4326, "ETH", 18, ["https://mainnet.megaeth.com/rpc"], "https://megaeth.blockscout.com", []],
  ["gunz", "GUNZ", 43419, "GUN", 18, ["https://rpc.gunzchain.io/ext/bc/2M47TxWHGnhNtq6pM5zPXdATBtuqubxn5EPFgFmEawCQr9WFML/rpc"], "https://gunzscan.io", []],
  ["mantle", "Mantle", 5000, "MNT", 18, ["https://mantle-rpc.publicnode.com", "https://rpc.mantle.xyz"], "https://mantlescan.xyz", []],
  ["scroll", "Scroll", 534352, "ETH", 18, ["https://scroll.rpc.sentio.xyz", "https://scroll.api.onfinality.io/public"], "https://scrollscan.com", []],
  ["linea", "Linea", 59144, "ETH", 18, ["https://rpc.linea.build", "https://linea-rpc.publicnode.com"], "https://lineascan.build", []],
  ["robinhood", "Robinhood Chain", 4663, "ETH", 18, ["https://rpc.mainnet.chain.robinhood.com"], "https://robinhoodchain.blockscout.com", ["robinhood-chain"]],
  ["ink", "Ink", 57073, "ETH", 18, ["https://rpc-gel.inkonchain.com", "https://ink.drpc.org"], "https://explorer.inkonchain.com", []],
  ["monad", "Monad", 143, "MON", 18, ["https://rpc.monad.xyz", "https://monad.drpc.org"], "https://monadexplorer.com", []],
  ["animechain", "Animechain", 69000, "ANIME", 18, ["https://rpc-animechain-39xf6m45e3.t.conduit.xyz", "https://69000.rpc.thirdweb.com"], "https://explorer.anime.xyz", ["anime"]],
  ["arc", "Arc", 5042, "USDC", 18, ["https://rpc.mainnet.arc.io", "https://arc.drpc.org"], "https://arc-scan.org", []],
  ["plasma", "Plasma", 9745, "XPL", 18, ["https://rpc.plasma.to"], "https://plasmascan.to", []],
  ["sonic", "Sonic", 146, "S", 18, ["https://rpc.soniclabs.com"], "https://sonicscan.org", []],
  ["tempo", "Tempo", 4217, "USD", 18, ["https://rpc.tempo.xyz"], "https://explore.tempo.xyz", []],
  ["world-chain", "World Chain", 480, "ETH", 18, ["https://worldchain-mainnet.g.alchemy.com/public"], "https://worldscan.org", ["worldchain"]]
];

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function makeChain([id, name, chainId, symbol, decimals, rpcUrls, explorerUrl, aliases], family = "evm") {
  const zeroExName = family === "svm" ? "solana" : ZERO_EX_CHAINS.get(chainId) ?? null;
  const readOnlyMetadata = Object.freeze({ readOnly: true });
  const nativeBalance = chainId !== 4217;
  const gasToken = chainId === 4217 ? "TIP-20" : chainId === 5042 ? "USDC" : null;
  const gasDecimals = family === "svm" ? 9 : chainId === 4217 ? 6 : chainId === 5042 ? 18 : 9;
  const gasUnit = family === "svm" ? "micro-lamports/CU" : chainId === 4217 ? "TIP-20" : chainId === 5042 ? "USDC" : "gwei";
  return freeze({
    id,
    slug: id,
    name,
    family,
    kind: family,
    chainId,
    symbol,
    decimals,
    nativeBalance,
    gasToken,
    gasDecimals,
    gasUnit,
    rangeUnit: family === "svm" ? "slots" : "blocks",
    rpcUrls: [...rpcUrls],
    explorerUrl,
    aliases,
    capabilities: {
      discovery: "read-only",
      gas: "metadata",
      swap: zeroExName ? "metadata" : "unlisted",
      execution: "disabled",
      discoveryReadOnly: true,
      gasMetadata: readOnlyMetadata,
      swapMetadata: zeroExName ? readOnlyMetadata : Object.freeze({ readOnly: true, supported: false })
    },
    discovery: readOnlyMetadata,
    gasMetadata: readOnlyMetadata,
    swapMetadata: zeroExName ? readOnlyMetadata : Object.freeze({ readOnly: true, supported: false }),
    execution: Object.freeze({ supported: false, readOnly: true }),
    zeroEx: {
      supported: Boolean(zeroExName),
      chainName: zeroExName,
      swapApi: Boolean(zeroExName),
      gaslessApi: Boolean(zeroExName) && family === "evm" && chainId !== 59144 && chainId !== 5042
    },
    readOnly: true
  });
}

const EVM_SOURCE = SOURCE_CHAINS.map((entry) => makeChain(entry));
const SOLANA = makeChain([
  "solana",
  "Solana",
  999999999991,
  "SOL",
  9,
  ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"],
  "https://explorer.solana.com",
  ["svm", "solana-mainnet"]
], "svm");

export const CHAIN_REGISTRY = freeze([...EVM_SOURCE, SOLANA]);
export const CHAINS = CHAIN_REGISTRY;
export const EVM_CHAINS = freeze(EVM_SOURCE);
export const SVM_CHAINS = freeze([SOLANA]);
export const ZERO_EX_SUPPORTED_EVM_CHAINS = freeze(EVM_SOURCE.filter((chain) => chain.zeroEx.supported));

const byId = new Map(CHAIN_REGISTRY.map((chain) => [chain.id, chain]));
const byChainId = new Map(CHAIN_REGISTRY.map((chain) => [String(chain.chainId), chain]));

export function findChain(selector) {
  if (typeof selector === "number" && Number.isSafeInteger(selector)) return byChainId.get(String(selector)) ?? null;
  if (typeof selector !== "string") return null;
  const value = selector.trim().toLowerCase();
  if (!value) return null;
  const direct = byId.get(value) ?? byChainId.get(value) ?? null;
  if (direct) return direct;
  return CHAIN_REGISTRY.find((chain) => chain.aliases.includes(value)) ?? null;
}

export function getChain(selector) {
  const chain = findChain(selector);
  if (!chain) throw new RangeError(`Unknown chain: ${String(selector)}`);
  return chain;
}

export function listChains(family) {
  if (family === "evm") return EVM_CHAINS;
  if (family === "svm") return SVM_CHAINS;
  return CHAIN_REGISTRY;
}

export function isEvmChain(selector) {
  return findChain(selector)?.family === "evm";
}

export function isSvmChain(selector) {
  return findChain(selector)?.family === "svm";
}

export function publicChain(chain) {
  return freeze({
    id: chain.id,
    slug: chain.slug,
    name: chain.name,
    family: chain.family,
    kind: chain.kind,
    chainId: chain.chainId,
    symbol: chain.symbol,
    nativeBalance: chain.nativeBalance,
    gasToken: chain.gasToken,
    gasDecimals: chain.gasDecimals,
    gasUnit: chain.gasUnit,
    rangeUnit: chain.rangeUnit,
    explorerUrl: chain.explorerUrl,
    capabilities: chain.capabilities,
    zeroEx: chain.zeroEx
  });
}
