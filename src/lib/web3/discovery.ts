import type { EIP1193Provider } from "viem";

export interface InjectedWallet {

  id: string;
  name: string;
  provider: EIP1193Provider;

}


/**
 * Resolve wallet metadata from provider flags
 */

function resolveWallet(
  provider: unknown
): InjectedWallet {

  if (!provider || typeof provider !== "object") {

    throw new Error(
      "[AETERNA] Invalid injected provider"
    );

  }

  return {

    id:
      provider.isMetaMask
        ? "metamask"
        : provider.isRabby
        ? "rabby"
        : provider.isCoinbaseWallet
        ? "coinbase"
        : provider.isOkxWallet
        ? "okx"
        : provider.isBraveWallet
        ? "brave"
        : "injected",

    name:
      provider.isMetaMask
        ? "MetaMask"
        : provider.isRabby
        ? "Rabby"
        : provider.isCoinbaseWallet
        ? "Coinbase Wallet"
        : provider.isOkxWallet
        ? "OKX Wallet"
        : provider.isBraveWallet
        ? "Brave Wallet"
        : "Injected Wallet",

    provider,

  };

}


export async function discoverInjectedWallets():

Promise<InjectedWallet[]> {

  const wallets: InjectedWallet[] = [];

  if (typeof window === "undefined") {
    return wallets;
  }


  const eth =
    (window as Window).ethereum as
      unknown;

  // Prefer canonical MetaMask provider when available
  if (eth?.isMetaMask) {
    return [resolveWallet(eth)];
  }


  /*
  legacy providers[]
  */

  const legacyProviders =
    eth?.providers;


  if (Array.isArray(legacyProviders)) {

    const metamask =
      legacyProviders.find(
        (p: unknown) =>
          typeof p === "object" &&
          p !== null &&
          "isMetaMask" in p &&
          (p as { isMetaMask?: boolean }).isMetaMask
      );

    if (metamask) {

      wallets.push(
        resolveWallet(metamask)
      );

    } else {

      wallets.push(
        resolveWallet(
          legacyProviders[0]
        )
      );

    }

  }


  /*
  fallback single-provider mode
  */

  else if (eth) {

    try {

      wallets.push(
        resolveWallet(eth)
      );

    }

    catch {
      // Intentional no-op: wallet resolution failure must not alter fail-closed path.
    }

  }


  /*
  EIP-6963 discovery
  */

  const eip6963Providers:
  InjectedWallet[] = [];


  function handler(
    event: Event
  ) {

    const detail =
      (event as CustomEvent<{
        info?: { rdns?: string; uuid?: string; name?: string };
        provider?: unknown;
      }>)
        .detail;

    if (
      !detail ||
      typeof detail !== "object"
    ) {
      return;
    }


    const {
      info,
      provider
    } = detail;


    if (!provider) {
      return;
    }


    eip6963Providers.push({

      id:
        info?.rdns ??
        info?.uuid ??
        info?.name ??
        "injected",

      name:
        info?.name ??
        "Injected Wallet",

      provider,

    });

  }


  window.addEventListener(
    "eip6963:announceProvider",
    handler
  );


  window.dispatchEvent(
    new CustomEvent(
      "eip6963:requestProvider"
    )
  );


  await new Promise(
    resolve =>
      setTimeout(resolve, 120)
  );


  window.removeEventListener(
    "eip6963:announceProvider",
    handler
  );


  wallets.push(
    ...eip6963Providers
  );


  /*
  deduplicate providers
  */

  const unique =
    new Map<
      EIP1193Provider,
      InjectedWallet
    >();


  for (const wallet of wallets) {

    if (
      wallet &&
      wallet.provider &&
      !unique.has(wallet.provider)
    ) {

      unique.set(
        wallet.provider,
        wallet
      );

    }

  }


  return Array.from(
    unique.values()
  );

}