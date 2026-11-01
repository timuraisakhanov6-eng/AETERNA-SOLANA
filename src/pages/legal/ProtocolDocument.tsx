import type { ReactNode } from "react";

/**
 * AETERNA — Protocol document (R9-A45 FINAL).
 *
 * ONE user-facing document with two sections ("How It Works", "Opening &
 * Presence"). "How It Works" ends with the "Important Limitations and User
 * Responsibility" block (encryption, lost links, storage availability,
 * content responsibility, liability). The second section deliberately does
 * NOT repeat the responsibility block.
 *
 * The Creator Presence extension rule mirrors the canonical project rule
 * (interval ≤ 30 days → extend by the interval; longer interval → extend by
 * exactly 30 days).
 */

const ProtocolSection = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <section className="mb-12 scroll-mt-24">
    <h2 className="text-lg font-semibold mb-4">{title}</h2>

    <div className="space-y-4 text-muted-foreground max-w-[65ch]">{children}</div>
  </section>
);

const ProtocolSubsection = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <div className="space-y-3">
    <h3 className="text-base font-semibold text-foreground/90">{title}</h3>

    <div className="space-y-4">{children}</div>
  </div>
);

export function HowItWorksSection() {
  return (
    <article>
      <ProtocolSection title="What Is an AETERNA Capsule?">
        <p>
          An <span translate="no">AETERNA</span> capsule is a digital time
          capsule designed to preserve content for a future moment.
        </p>

        <p>
          The creator adds content, chooses an opening date, and seals the
          capsule. Once sealed, the capsule&apos;s contents cannot be edited,
          replaced, or supplemented.
        </p>
      </ProtocolSection>

      <ProtocolSection title="Sealing a Capsule">
        <p>
          Sealing fixes the contents of a capsule. The content remains
          unchanged after sealing.
        </p>

        <p>
          The scheduled opening date may change under the Creator Presence
          rules described in the Opening &amp; Presence section. A change to the
          opening date does not change the sealed contents.
        </p>
      </ProtocolSection>

      <ProtocolSection title="Creator Credit and Storage">
        <p>Creating a capsule requires an available Creator Credit.</p>

        <p>
          One Creator Credit costs USD 1.00 and grants the right to create one
          capsule. A new credit only needs to be purchased when no available
          credit remains.
        </p>

        <p>
          A Creator Credit is consumed only after a capsule has been
          successfully published and sealed. If the creation process does not
          finish successfully, the credit remains available for another
          attempt.
        </p>

        <p>
          Capsule storage is paid separately. The storage payment is calculated
          according to the size of the encrypted capsule data and is shown
          before payment.
        </p>

        <p>
          <span translate="no">AETERNA</span> currently uses a one-time,
          long-term storage model. There is no mandatory monthly or annual
          storage renewal under the current model.
        </p>

        <p>
          Storage is provided through an independent network. Its
          infrastructure and continued operation are outside{" "}
          <span translate="no">AETERNA</span>&apos;s direct control.{" "}
          <span translate="no">AETERNA</span> cannot guarantee uninterrupted
          availability or make an absolute guarantee of perpetual access.
        </p>
      </ProtocolSection>

      <ProtocolSection title="Capsule Access">
        <p>
          An <span translate="no">AETERNA</span> capsule remains accessible
          through its complete link before and after opening.
        </p>

        <p>
          While sealed, the capsule displays its current status and opening
          information. Once the opening conditions are met, its contents become
          available for viewing and download.
        </p>
      </ProtocolSection>

      <ProtocolSection title="Important Limitations and User Responsibility">
        <ProtocolSubsection title="Encryption and Access">
          <p>
            Capsule contents are encrypted in the creator&apos;s browser before
            they are uploaded.
          </p>

          <p>
            <span translate="no">AETERNA</span> does not receive or store the
            secret information required to decrypt capsule contents.{" "}
            <span translate="no">AETERNA</span> cannot read, view, decrypt,
            recover, or modify the private contents of a capsule.
          </p>

          <p>
            The complete capsule link contains the information required to
            access the capsule. Anyone who obtains the complete link may be
            able to access the capsule once its opening conditions are met.
          </p>

          <p>
            The creator is responsible for keeping the complete capsule link
            secure and sharing it only with intended recipients.
          </p>
        </ProtocolSubsection>

        <ProtocolSubsection title="Lost Links and Recovery">
          <p>
            <span translate="no">AETERNA</span> does not store copies of the
            secret information required to decrypt capsule contents.
          </p>

          <p>
            If the complete capsule link or its secret component is lost,{" "}
            <span translate="no">AETERNA</span> cannot recover, recreate, or
            replace it. <span translate="no">AETERNA</span> cannot restore
            access to the capsule.
          </p>

          <p>
            <span translate="no">AETERNA</span> cannot revoke or regenerate a
            lost access link.
          </p>
        </ProtocolSubsection>

        <ProtocolSubsection title="Storage and Availability">
          <p>
            <span translate="no">AETERNA</span> is a digital time capsule
            protocol, not a guaranteed delivery service, custodial service, or
            conventional cloud storage provider.
          </p>

          <p>
            Capsule storage relies on independent network infrastructure and
            external services that are outside{" "}
            <span translate="no">AETERNA</span>&apos;s direct control.
          </p>

          <p>
            Although <span translate="no">AETERNA</span> is designed for
            long-term preservation, it cannot guarantee uninterrupted
            availability, successful retrieval at every future time, or
            absolute permanence under all circumstances.
          </p>

          <p>
            <span translate="no">AETERNA</span> is intended as an additional
            preservation layer, not the sole storage location for important
            materials. Users are encouraged to maintain independent copies of
            important content.
          </p>
        </ProtocolSubsection>

        <ProtocolSubsection title="Content and Legal Responsibility">
          <p>
            The creator is solely responsible for the legality, ownership,
            permissions, and distribution of all content placed in a capsule.
          </p>

          <p>
            The creator must have all rights and permissions required to store
            and share that content.
          </p>

          <p>
            Because capsule contents are encrypted before upload,{" "}
            <span translate="no">AETERNA</span> cannot inspect, moderate, or
            modify the encrypted content itself.
          </p>
        </ProtocolSubsection>

        <ProtocolSubsection title="Limitation of Liability">
          <p>
            To the extent permitted by applicable law,{" "}
            <span translate="no">AETERNA</span> is not responsible for loss of
            access resulting from lost or disclosed capsule links, loss of
            secret information controlled by the creator, or interruptions and
            failures of independent storage networks and external services.
          </p>

          <p>
            Nothing in this Protocol excludes or limits liability that cannot
            be excluded or limited under applicable law.
          </p>
        </ProtocolSubsection>
      </ProtocolSection>
    </article>
  );
}

export function OpeningPresenceSection() {
  return (
    <article>
      <ProtocolSection title="How a Capsule Opens">
        <p>Each capsule has a scheduled opening date and time.</p>

        <p>
          Until the opening conditions are met, the capsule remains sealed.
          Once those conditions are met, its contents become available through
          the complete capsule link.
        </p>

        <p>
          The current status and opening information are displayed on the
          capsule page.
        </p>
      </ProtocolSection>

      <ProtocolSection title="Creator Presence">
        <p>
          Creator Presence is part of every <span translate="no">AETERNA</span>{" "}
          capsule. The Confirm Presence button is always displayed, but its
          availability depends on the opening interval.
        </p>

        <ul className="list-disc pl-5 space-y-2">
          <li>
            <strong className="font-medium text-foreground/90">
              30 days or less:
            </strong>{" "}
            the button is available throughout the interval.
          </li>
          <li>
            <strong className="font-medium text-foreground/90">
              More than 30 days:
            </strong>{" "}
            the button becomes available when 30 days remain before the
            scheduled opening.
          </li>
        </ul>

        <p>
          Each successful confirmation renews the opening period. For intervals
          of 30 days or less, the original interval is used. For longer
          intervals, the renewal period is exactly 30 days. A successful
          confirmation may therefore move the opening date forward.
        </p>

        <p>
          If no further confirmation is made, the capsule becomes eligible to
          open at its current scheduled opening time. Missing a confirmation
          does not itself postpone the opening date.
        </p>

        <p>The latest opening date is displayed on the capsule page.</p>
      </ProtocolSection>

      <ProtocolSection title="Creator Link and Recipient Link">
        <p>
          <span translate="no">AETERNA</span> provides two different links for
          each capsule.
        </p>

        <p className="font-medium text-foreground/90">Creator Link</p>

        <p>
          The Creator Link is intended for the creator. It provides access to
          creator-specific actions, including Creator Presence confirmation.
        </p>

        <p>
          Keep this link private. It should not be shared with recipients.
        </p>

        <p className="font-medium text-foreground/90">Recipient Link</p>

        <p>
          The Recipient Link is intended for the people receiving the capsule.
          It provides access to the capsule page and, when the opening
          conditions are met, its contents.
        </p>

        <p>Share this link with the intended recipients.</p>
      </ProtocolSection>

      <ProtocolSection title="After Opening">
        <p>
          When the opening conditions are met, the capsule&apos;s status
          changes to opened and its contents become available.
        </p>

        <p>
          Opening does not remove the capsule or change its contents. The
          capsule remains accessible through its complete link.
        </p>

        <p>
          The creator and recipients can refer to the capsule page to see its
          current status.
        </p>
      </ProtocolSection>
    </article>
  );
}
