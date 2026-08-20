Status

FINAL LOCK STABLE

Aligned with the AETERNA Canonical Documentation.

Human-readable product description.

Normative protocol behavior is defined by the canonical documentation of AETERNA, including:

- AETERNA Complete Engineering Model
- AETERNA Complete System Logic
- Applicable Canonical Specifications

This document is a human-readable explanation of the canonical project behavior.

It does not redefine the protocol.

AETERNA — Complete Project Logic

What is AETERNA

AETERNA is a digital time capsule.
Its purpose is to preserve information unchanged until a pre-selected moment.
Once sealed, the contents cannot be altered.
No one can open the capsule early.
No one can replace the files.
No one can tamper with the contents.
Not even AETERNA itself knows what's inside a capsule, because everything is encrypted directly in the user's browser.

No one, including AETERNA's developers, has the technical ability to decrypt a capsule's contents without the user's secret link.

The Creator's Path

Creating a capsule

The creator opens the site.
Clicks Create Capsule.
An editor for the new capsule opens in front of them.
Until the capsule is sealed, it belongs entirely to the creator and can be freely modified.

Adding content

The creator can add almost any digital content.
For example:

text messages;
letters;
photos;
videos;
audio files;
documents;
archives;
any other files.

Besides uploading ready-made files, content can also be created directly on the site.
For example:

write a letter;
record a voice message;
take a photo with the camera;
record a video.

In other words, the user doesn't need to prepare files in advance — a capsule can be created entirely inside AETERNA.

Data in the editor

While the user is creating a capsule, all data stays only in the user's browser.
Files are not sent to the server.
Text is kept in the application's memory.
Media is displayed via temporary browser URLs (Blob URLs).
The user can edit the content without limit before the capsule is prepared.

Viewing content

Every object inside the capsule is clickable.
Before sealing, the user can open any element.
Viewing happens locally. Video, audio, and images are not copied into memory again. The browser plays the original file directly through a temporary Blob URL. Thanks to this, even large files can be previewed without unnecessary memory overhead.
For example:

a photo opens in a viewer;
a video can be watched;
audio can be played;
text can be opened and continued.

If someone spots a mistake, they can simply fix it.
They can:

delete a file;
replace a file;
edit text;
add more material;
reorder elements.

While the capsule is still in this editable, pre-PREPARED phase, there are no restrictions on content changes at all. Once preparation completes and the capsule reaches PREPARED, its cryptographic part becomes immutable — independent of and prior to payment (see the PREPARED state below).

Cost is shown as a fixed service fee.

AETERNA uses a Creator Credit model:
- one fixed USD 1.00 service fee;
- one Creator Credit gives the creator the right to attempt to create one successful capsule;
- capsule size does not change the AETERNA service fee;
- storage volume does not change the AETERNA service fee;
- the exact payment asset is determined by the supported AETERNA service-payment flow.
- the exact Irys publication asset is determined by the supported Irys publication flow.

The user always sees the cost of their capsule in advance and never encounters an unexpected sum at the end of the process.

After clicking Continue, the displayed fee is fixed as the creator service fee. This value becomes part of the Creator Service Quote and no longer changes.

The user never sees the project's internal economics. All costs for storage, infrastructure, network fees, and AETERNA's internal economics are completely hidden from the user.

Pricing logic

Cost is shown as a fixed service fee.

AETERNA uses a Creator Credit model:
- one fixed USD 1.00 service fee;
- one Creator Credit gives the creator the right to attempt to create one successful capsule;
- capsule size does not change the AETERNA service fee;
- storage volume does not change the AETERNA service fee;
- the exact payment asset is determined by the supported AETERNA service-payment flow.
- the exact Irys publication asset is determined by the supported Irys publication flow.

Internal operational calculations may exist for capacity planning or storage scheduling, but they MUST NOT determine, modify, or influence the AETERNA service fee, Creator Credit amount, payment entitlement, or eligibility. Capsule size and storage blocks are not AETERNA service pricing inputs.

What's included in the price

The user pays only for their own content.
They do not pay for:

the Manifest;
the Vault;
cryptography;
internal metadata;
the number of chunks;
the project's internal costs;
internal structures;
infrastructure.

They see only one clear price.

Choosing the opening date

Once the content is ready, the creator chooses an opening date.
For example:

a month from now;
a year from now;
ten years from now.

By default, the capsule will open on exactly that day.

Confirm Presence

Every capsule automatically supports the Confirm Presence feature. There's no need to enable it separately — it's built into every capsule by default.

If the Confirm Presence feature is available according to the rules of the originally selected opening interval, the effective opening moment can be automatically postponed.

If the originally selected opening interval is 30 days or less,
the Confirm Presence button becomes available immediately after sealing.

Each confirmation postpones the effective opening moment by the originally selected interval.

For example:

The opening date is 9 days away.

The creator confirms presence.

The opening moment is postponed by another 9 days.

If the original opening interval exceeds 30 days,
the Confirm Presence button is shown right away,
but only becomes active during the final 30 days before opening.

Before it becomes active, the creator can still see how much time remains until opening and how many days remain until the ability to confirm presence appears.

Once 30 days remain,
each confirmation postpones the effective opening moment by exactly another 30 days.

If confirmations stop,
the capsule automatically opens once the final 30 days have elapsed.

For example.

A capsule is created with a 365-day interval.

For the first 335 days, the Confirm Presence button is unavailable — the creator only sees a countdown to its appearance.

Once 30 days remain, the button becomes active.

Each confirmation postpones the effective opening moment by another 30 days.

If confirmations stop, the capsule automatically opens once the final 30 days have elapsed.

In every case, only the effective opening moment changes.
The capsule's contents never change.

Preparation before payment

Once everything is ready, the creator clicks Continue.
This is when the actual preparation of the capsule begins.

Once preparation completes successfully, the capsule enters the PREPARED state. From this moment on, the capsule's cryptographic part is fully formed and no longer changes.

Up to this point, no payment has occurred yet.
The browser (Runtime — the user's local execution environment) begins doing the heavy lifting:

during preparation, large files are read as a stream;
each piece is encrypted immediately;
after encryption, it's placed into the browser's temporary Runtime storage;
only a small part of the file is in memory at any given time;
the necessary hashes are computed;
the Vault is assembled;
the capsule is prepared for sealing.

If an error occurs at this stage, the payment window never opens.
The person pays nothing.

Payment

Once preparation completes successfully, the backend creates a Creator Service Quote.
This quote records the fixed USD 1.00 service fee, the selected payment asset, the exact crypto amount, the recipient, and wallet binding metadata.
It does not record capsule size or storage-block pricing.
This becomes the commercial entitlement for this capsule attempt and is used at every subsequent payment stage.

The Creator Service Quote is the sole commercial source of truth within Business Authority. Once created, the service entitlement amount is fixed.

The payment window then opens.

The creator sees the fixed USD 1.00 service fee. This amount no longer changes during payment.

There are no hidden service fees or sudden price increases.
Payment is performed through the approved AETERNA service-payment flow and grants one Creator Credit.
Irys publication payment is a separate flow, and its supported assets/networks may differ from the AETERNA service-payment flow.

After successful payment verification, one AVAILABLE Creator Credit is created.
The creator does not need to pay the AETERNA service fee again while that credit is AVAILABLE.

Irys publication and storage are separate from the AETERNA service fee.
Irys determines the actual cost of storing and publishing the encrypted capsule data based on the published content.
That cost is paid by the creator through the Irys publication/storage flow supported by the current production integration.
AETERNA does not bundle Irys cost into its fixed service fee.

Sealing

After payment, the user no longer takes part in the process.
They see only a waiting page.
Behind the scenes, the system:

Runtime — this is the user's local execution environment (Browser Runtime/Persistent Runtime), not a server. Runtime opens a temporary session. This session never becomes part of the permanent, immutable storage and exists only until sealing is complete. Runtime exists only until publication is complete. With Persistent Runtime, it can survive a page reload, tab closure, or browser restart in order to continue publication.
Runtime receives an Upload Token issued by the Business Layer after payment has been successfully verified. The Business Layer is the sole issuer/authorizer of the Upload Token; the Executor only verifies and consumes it during publication and does not grant publish rights itself.
Encrypted chunks are read one at a time.
Each chunk is uploaded through the Storage Layer into permanent, immutable storage.
Once the upload is confirmed, the chunk is immediately deleted from Runtime.
Once all chunks are uploaded, the Vault is uploaded.
Integrity is verified.
The Manifest is created.
The Manifest is published last. Only after the Manifest is successfully published is the capsule considered finally sealed.
Once sealing completes successfully, the user gains access to the previously generated Creator Link and Recipient Link associated with this capsule.
After successful publication, Runtime ends the temporary session and completely clears all preparation data.

Executor

The Executor is a trusted publication service.

The Executor only:

verifies the Upload Token;
accepts already-encrypted data;
publishes it through the Storage Layer into permanent, immutable storage;
confirms successful publication.
The Executor never decrypts data and cannot alter its contents. It performs exclusively the function of a trusted publication service.

At the same time, the Executor never receives:

the user's secret;
the encryption key;
plaintext data.

After sealing

Once sealing is complete, all of Runtime's temporary data is destroyed.

What remains permanently are the Vault, the Manifest, and the necessary Storage Layer service data that provide access to the encrypted content.

The temporary preparation structures no longer exist.

After the Manifest is published, any attempt to modify the capsule results in the creation of a new, independent capsule with a new Capsule ID. The original capsule remains unchanged forever.

The creator lands on their capsule's page and receives two different links.

Creator Link

This is the owner's link.
Through it, they have access to:

viewing the capsule's status;
the Confirm Presence button (if it has become available according to the Confirm Presence rules);
viewing the Recipient Link;
printing information about the capsule.

This is the page the creator sees right after sealing completes.

Recipient Link

This is the link for the recipient.
It can be sent to anyone.
This link never shows a Confirm Presence button or any other owner-only features.

The Recipient's Path

The recipient doesn't need an account.
No registration is required.
No app is required.
They simply open the link.
If the opening time hasn't arrived yet, they see a waiting page.
If the opening time has arrived, the contents open immediately.

Before opening

Before the opening date arrives, both the creator and the recipient see the CapsuleView.
The creator sees it with their own capabilities.
The recipient sees it with viewing capabilities only.
Only the creator can use Confirm Presence, once that capability becomes available according to the originally selected opening interval.

After opening

As soon as the permitted opening moment arrives, the waiting page is no longer shown.
After opening, the Manifest is loaded first. Based on it, the location of the Vault is determined and the Vault is downloaded and decrypted. Per-object chunk locations for the capsule's objects are then resolved via Storage Authority's Chunk Pointer Registry, after which the user receives the list of the capsule's objects. Each object opens independently.

Text

Text loads completely right away.

Images

An image loads only at the moment it's opened. After the viewer is closed, the decrypted data is released, so the browser doesn't keep all images in memory at once.

Video

Video is never loaded in full. The player progressively requests the chunks it needs. Each chunk received is decrypted right before playback and immediately becomes available to the player. Once a chunk is no longer needed, memory is released. Thanks to this, memory usage stays practically constant regardless of the video's size. This works similarly to modern streaming video services.

Audio

Works the same way as video.

Large files

When downloading, a file is reconstructed as a stream. Only a small portion of the data is in memory at any given time. Even very large capsules can be opened without loading the full content into RAM. The size of the capsule does not determine how much memory is needed to open it. Memory usage depends only on the size of the chunk being processed at any given moment.

Emergency system

This is one of AETERNA's key features.
If the main site stops working for any reason, the user shouldn't notice.
Instead of the main page, Emergency Runtime launches automatically.

What the user sees

They see essentially the same CapsuleView.
The same design. The same buttons. The same capabilities.
The only difference is that an independent backup implementation is used, one that is compatible with the main protocol and uses the same cryptographic formats for the Vault and Manifest.

If the creator's link is opened

Emergency Runtime detects that this is the Creator Link.
It shows:

Confirm Presence (if it's currently available according to the canonical rules);
Creator Link;
Recipient Link;
Print.

The Confirm Presence button works exactly the same way as on the main site.

If the recipient's link is opened

Emergency Runtime detects that this is the Recipient Link.
An ordinary waiting page is shown, with no owner-only features.

If the opening time hasn't arrived yet

Emergency Runtime shows the same waiting page as the main site.

If the opening time has already arrived

Emergency Runtime does not show the waiting page.
It immediately:

loads the Manifest;
retrieves the encrypted Vault via the Manifest;
decrypts it locally;
opens the contents.

To the user, everything looks exactly as if the main site were still running.

Storage logic

During preparation

The file is read in parts → each chunk is encrypted immediately → Runtime stores it temporarily → the original part of the file is released.

After payment

Runtime reads the encrypted chunk → passes it through the Storage Layer, using the previously received Upload Token. The Executor publishes the chunk into permanent, immutable storage, after which Runtime receives confirmation of successful publication, deletes the temporary copy of the chunk, and moves on to the next one.

After opening

A chunk is loaded only when needed → decrypted → used → memory is released.

Memory behavior

AETERNA is specifically designed not to hold large amounts of data in the browser's memory at once.
AETERNA never requires the entire capsule to be held in memory at the same time.
Streaming processing is used during preparation, upload, and opening.
At any given moment, only a small part of the file is in memory.
RAM usage is determined by the size of the chunk being processed, not by the capsule's total size.
Thanks to this, it's possible to work with capsules several gigabytes in size even on ordinary computers and mobile devices.

Immutability of content

Once sealing completes successfully, the capsule's content becomes immutable.
After that, it is impossible to:

edit the text;
replace a file;
delete an object;
add new material;
reorder elements;
manually change the opening date;
change the cryptographic parameters.

The effective opening moment can only be automatically postponed according to the Confirm Presence rules. The Confirm Presence rules are determined by the originally selected opening interval. No other way to change the opening date after sealing exists.

Any modification results in the creation of a new capsule.
This is consistent with the project's architecture.

Project economics

The user never sees the project's internal economics.
They only know the cost of their capsule.
Internally, AETERNA pays for:

permanent storage;
network fees;
infrastructure maintenance;
redundancy;
project development.

If storage optimization allows the project to reduce its own costs, that difference remains AETERNA's internal margin. If costs rise, that likewise remains the project's concern, not the user's.

AETERNA's core promise

For the user, everything comes down to one simple promise:

"I create a capsule once, I see its cost in advance, I pay exactly that amount, after which it is reliably stored unchanged and will automatically open at the effective opening moment — even if the main site ever stops working."

AETERNA's main goal is to make using a digital time capsule as simple as possible for people, by hiding all the complexity of cryptography, storage, and streaming data processing inside the system.