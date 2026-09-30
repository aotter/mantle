/** The transactional-email port (Better Auth email OTP and magic link, staff invitations). The sender decides how to branch on `locale`; `category` names the template lane. */
export interface EmailSender {
  send(args: EmailSendArgs): Promise<void>;
}

export interface EmailSendArgs {
  readonly to: string;
  readonly subject: string;
  /** Plain-text body — always required so non-HTML clients work. */
  readonly text: string;
  /** Optional HTML body. */
  readonly html?: string;
  /** BCP 47 locale the recipient is expected to read. */
  readonly locale: string;
  /** Optional categorization for templating / deliverability segmentation. */
  readonly category?: string;
}
