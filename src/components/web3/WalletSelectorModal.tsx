/**
 * AETERNA — WalletSelectorModal
 *
 * Production-grade injected wallet selector
 *
 * Supports:
 * ✔ EIP-6963 providers[]
 * ✔ MetaMask proxy injector (2024+)
 * ✔ Coinbase Wallet
 * ✔ Rabby
 * ✔ Brave Wallet
 * ✔ OKX Wallet
 * ✔ WalletConnect fallback
 *
 * UI-layer only
 * Protocol-safe
 */

import {

  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle

} from "@/components/ui/dialog"

import { Button }
from "@/components/ui/button"

import {

  InjectedWallet

} from "@/lib/web3/discovery"


/* ───────────────── ICON MAP ───────────────── */

/**
 * Local wallet icon paths — served from /public/wallets/.
 *
 * External URLs removed: remote icon sources create third-party
 * runtime dependencies, CSP exposure, and offline breakage.
 * All assets must be present at build time under public/wallets/.
 */

const walletIcons:
Record<string, string> = {

  metamask:  "/wallets/metamask.svg",
  coinbase:  "/wallets/coinbase.svg",
  rabby:     "/wallets/rabby.svg",
  brave:     "/wallets/brave.svg",
  okx:       "/wallets/okx.svg",

}


/* ───────────────── TYPES ───────────────── */

interface Props {

  open: boolean

  wallets:
  InjectedWallet[]

  onSelect:
  (wallet:
    InjectedWallet
  ) => void

  onWalletConnect:
  () => void

  onClose?: () => void

}


/* ───────────────── COMPONENT ───────────────── */

export default function
WalletSelectorModal({

  open,
  wallets,
  onSelect,
  onWalletConnect,
  onClose,

}: Props) {


  return (

    <Dialog
      open={open}
      onOpenChange={(v) => {

        if (!v && onClose)
          onClose()

      }}
    >

      <DialogContent
        className="
        space-y-4
        max-w-sm
      "
      >

        <DialogHeader>

          <DialogTitle>
            Connect Wallet
          </DialogTitle>

        </DialogHeader>


        <div
          className="
          flex
          flex-col
          gap-2
        "
        >

          {

            wallets.map(

              (wallet) => {

                /**
                 * Own-property guard — prevents prototype-key collisions
                 * and inherited property access on the icon map.
                 * wallet.id comes from runtime discovery and must not be
                 * trusted as a safe object key without explicit narrowing.
                 */

                const iconSrc =
                  Object.prototype.hasOwnProperty.call(
                    walletIcons,
                    wallet.id
                  )
                    ? walletIcons[wallet.id]
                    : null;

                return (

                  <Button

                    key={wallet.id}

                    variant="outline"

                    onClick={() =>
                      onSelect(wallet)
                    }

                    className="
                    flex
                    items-center
                    justify-start
                    gap-3
                    h-12
                    text-left
                    "

                  >

                    {iconSrc && (

                      <img

                        src={iconSrc}

                        alt={wallet.name}

                        className="
                        w-6
                        h-6
                        "

                      />

                    )}

                    <span>
                      {wallet.name}
                    </span>

                  </Button>

                )

              }

            )

          }


          {/* WalletConnect fallback */}

          <Button

            variant="secondary"

            onClick={
              onWalletConnect
            }

            className="
            flex
            items-center
            justify-start
            gap-3
            h-12
            "

          >

            <img

              src="/wallets/walletconnect.svg"

              alt="WalletConnect"

              className="
              w-6
              h-6
              "

            />

            WalletConnect

          </Button>

        </div>

      </DialogContent>

    </Dialog>

  )

}