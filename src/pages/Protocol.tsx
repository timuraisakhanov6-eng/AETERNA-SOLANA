import { Link } from "react-router-dom";
import type { ReactNode } from "react";

const Protocol = () => {
  return (
    <div className="relative min-h-screen bg-background text-foreground flex flex-col overflow-hidden">

      <main
        role="main"
        className="relative z-10 w-full max-w-3xl mx-auto px-6 md:px-10 lg:px-12 pt-20 pb-28 flex-1"
      >
        <header className="mb-14">
          <h1 className="font-display text-2xl md:text-3xl font-semibold mb-2">
            AETERNA Protocol
          </h1>

          <p className="text-muted-foreground">
            Please read carefully before sealing a capsule.
          </p>

          <p className="mt-3 text-sm text-muted-foreground italic">
            AETERNA is a digital time capsule protocol, not a guaranteed delivery
            service, cloud storage provider, or custodial platform.
          </p>
        </header>

        <div className="text-[15px] leading-[1.85]">

          <Section title="1. What is an AETERNA Capsule?">
            <p>
              AETERNA is a digital time capsule protocol.
            </p>

            <p>
              You can place messages, photos, videos, documents, and other files
              into a capsule, choose when it may be opened, and share the access
              link with another person or keep it for yourself.
            </p>

            <p>
              The capsule contents are encrypted in your browser before upload.
              AETERNA cannot read, recover, or modify your private contents.
            </p>

            <p>
              AETERNA is a protocol, not a guaranteed delivery service, cloud
              storage provider, or custodial platform.
            </p>

            <p>
              AETERNA is designed to provide an additional independent layer
              of long-term digital preservation.
            </p>

            <p>
              Users are encouraged to maintain their own copies of important
              materials. AETERNA should be viewed as an additional preservation
              layer rather than the sole storage location for critical data.
            </p>
          </Section>


          <Section title="2. How access works">
            <p>
              To open a capsule, two conditions must be satisfied:
            </p>

            <ul>
              <li>The unlock date or unlock conditions must be satisfied.</li>
              <li>The complete capsule link must be available.</li>
            </ul>

            <p>
              Possession of a capsule ID alone is not sufficient.
            </p>

            <p>
              The protocol verifies eligibility using trusted server time rather
              than the local device clock.
            </p>
          </Section>


          <Section title="3. About the capsule link">
            <p>
              The capsule link is a private access reference that includes a
              secret fragment required for decryption. This fragment is never
              transmitted to servers.
            </p>

            <p>
              Anyone who possesses the complete capsule link may be able to
              access the capsule once the unlock conditions are satisfied.
            </p>

            <p>
              You are responsible for protecting and distributing the link.
            </p>

            <p>
              If the link is lost, access cannot be restored. AETERNA does not
              store copies of secret fragments and cannot regenerate, revoke,
              or recover access links.
            </p>
          </Section>


          <Section title="4. Permanence and sealing">
            <p>
              After payment is completed and the capsule is successfully sealed,
              the protocol commits the capsule to permanent storage.
            </p>

            <p>After sealing:</p>

            <ul>
              <li>Capsule contents cannot be edited</li>
              <li>Unlock conditions cannot be modified</li>
              <li>Manifest data becomes final</li>
            </ul>

            <p>
              This behavior is intentional and forms part of the protocol's
              immutability guarantees.
            </p>
          </Section>


          <Section title="5. Pricing and storage blocks">
            <p>
              Pricing reflects the amount of encrypted storage allocated for
              the capsule vault container.
            </p>

            <ul>
              <li>First 20 MB: $4.00</li>
              <li>Each additional 20 MB block: $3.00</li>
            </ul>

            <p>
              Payment is performed once during sealing. The protocol does not
              require subscriptions or recurring payments.
            </p>
          </Section>


          <Section title="6. Responsibility for content">
            <p>
              You are solely responsible for the legality, ownership, and
              distribution of any content placed into a capsule.
            </p>

            <ul>
              <li>You control the rights to the content</li>
              <li>The content is lawful in your jurisdiction</li>
            </ul>

            <p>
              Because capsules are encrypted client-side, AETERNA cannot view,
              modify, moderate, or remove capsule contents.
            </p>
          </Section>


          <Section title="7. What happens at unlock time">
            <p>
              Unlock eligibility is evaluated in UTC using trusted server time.
            </p>

            <ul>
              <li>The capsule may become accessible</li>
              <li>Anyone with the complete capsule link can open it</li>
              <li>The protocol does not send automatic notifications</li>
            </ul>

            <p>
              AETERNA does not guarantee that a recipient will open, receive,
              download, or review a capsule. The protocol only determines whether
              access becomes available.
            </p>
          </Section>


          <Section
            id="creator-presence"
            title="8. Creator Presence Confirmation"
          >
            <p>
              Every AETERNA capsule includes a Recipient Link and a Creator Link.
            </p>

            <p>
              Both links can open the capsule once its opening conditions have
              been satisfied.
            </p>

            <p>
              The Creator Link also provides access to the Creator Presence feature.
            </p>

            <p>
              A capsule may be used as a traditional time capsule by selecting
              an opening date and simply waiting until that date arrives.
            </p>

            <p>
              Alternatively, the creator may choose to periodically confirm
              presence using the Creator Link.
            </p>

            <p>
              Each successful confirmation starts a new confirmation period
              using the interval originally defined when the capsule was created.
            </p>

            <p>
              As long as confirmations continue to be received before the current
              confirmation period expires, the capsule remains sealed.
            </p>

            <p>
              If confirmations stop, the capsule eventually becomes eligible
              for opening according to its configured schedule.
            </p>

            <p>
              This allows a capsule to function either as a traditional time
              capsule or as a presence-based release mechanism, depending on
              how the creator chooses to use it.
            </p>

            {/* ── Recipient Notice ── */}
            <div className="mt-8 rounded-xl border border-border/60 bg-card/40 overflow-hidden">
              {/* Header bar */}
              <div className="flex items-center gap-2.5 px-5 py-3 border-b border-border/60 bg-muted/30">
                {/* Pulse dot */}
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-foreground/50 opacity-50" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-foreground/70" />
                </span>
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-foreground/80">
                  Recipient Notice
                </p>
              </div>

              {/* Body */}
              <div className="px-5 py-5 space-y-3 text-sm leading-relaxed text-muted-foreground">
                <p>
                  If Creator Presence Confirmation is enabled, the opening date
                  displayed to recipients may change over time.
                </p>

                <p className="font-medium text-foreground/90">
                  This behavior is expected.
                </p>

                <p>
                  A change in the displayed opening date does not indicate an
                  error or malfunction. It means the creator has successfully
                  confirmed presence before the current confirmation period expired.
                </p>

                <p>
                  As long as confirmations continue, the capsule remains sealed.
                </p>

                <p>
                  If confirmations stop, the capsule will automatically become
                  eligible for opening according to its configured schedule.
                </p>
              </div>
            </div>
          </Section>


          <Section title="9. Payments">
            <p>
              Capsule pricing is determined by the storage capacity selected
              during capsule creation.
            </p>

            <p>
              The displayed capsule price is the final creator price.
            </p>

            <p>
              Payments may be processed through supported payment providers,
              including bank card payments and supported digital asset networks.
            </p>

            <p>
              Payment providers operate independently from AETERNA.
            </p>

            <p>
              Refunds, chargebacks, taxes, currency conversion fees, and
              payment processing policies may be subject to the rules of the
              applicable payment provider.
            </p>

            <p>
              AETERNA may internally perform storage settlement operations
              required to create and preserve capsules.
            </p>

            <p>
              Such operations are part of the capsule creation process and
              do not require additional creator payments.
            </p>
          </Section>


          <Section title="10. Long-Term Preservation">
            <p>
              AETERNA is designed for long-term preservation of digital
              memories and future access to sealed capsule contents.
            </p>

            <p>
              No digital preservation system can guarantee absolute permanence
              under all possible circumstances.
            </p>

            <p>
              AETERNA relies on software, infrastructure, storage providers,
              networks, and external services that may evolve over time.
            </p>

            <p>
              While the protocol is designed to maximize long-term
              accessibility, users are encouraged to maintain independent
              backups of important materials whenever possible.
            </p>
          </Section>


          <section className="mb-14 rounded-xl border border-border bg-card/60 px-6 py-5">
            <h2 className="text-lg font-semibold mb-3">
              11. Before continuing, please understand:
            </h2>

            <ul className="list-disc pl-5 space-y-2 text-muted-foreground mb-4">
              <li>Capsules cannot be edited after sealing</li>
              <li>Lost links cannot be recovered</li>
              <li>
                Anyone with the complete capsule link may open the capsule after
                unlock conditions are satisfied
              </li>
              <li>Some capsules may use Creator Presence Confirmation</li>
              <li>AETERNA cannot access encrypted contents</li>
              <li>Payments are final once capsule sealing succeeds</li>
              <li>
                AETERNA should be viewed as an additional preservation layer,
                not the sole storage location for critical data
              </li>
            </ul>

            <p className="text-sm text-muted-foreground italic">
              By continuing, you confirm informed and voluntary participation in
              the AETERNA temporal capsule protocol.
            </p>
          </section>


          <footer className="relative z-20 pt-10 border-t border-border bg-background/80 backdrop-blur-sm">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <p className="text-sm text-muted-foreground">
                AETERNA — a cryptographic time capsule protocol. Sealed now. Opened later.
              </p>

              <div className="flex gap-4">
                <Link
                  to="/"
                  className="text-sm text-muted-foreground hover:underline"
                >
                  ← Back to Home
                </Link>

                <Link
                  to="/create"
                  className="text-sm font-medium text-foreground hover:underline"
                >
                  Proceed to capsule creation →
                </Link>
              </div>
            </div>
          </footer>

        </div>
      </main>
    </div>
  );
};

const Section = ({
  title,
  id,
  children,
}: {
  title: string;
  id?: string;
  children: ReactNode;
}) => (
  <section
    id={id}
    className="mb-12 scroll-mt-24"
  >
    <h2 className="text-lg font-semibold mb-4">{title}</h2>

    <div className="space-y-4 text-muted-foreground max-w-[65ch]">
      {children}
    </div>
  </section>
);

export default Protocol;