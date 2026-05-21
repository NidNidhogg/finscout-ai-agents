import type { EnrichedProfile } from '../schema/enrichedProfile';

// ── Shared email-draft type ────────────────────────────────────────────────────
// Canonical location: imported by mail-sender consumers (e.g. HITL CLI).
// Shape mirrors the EmailDraft interface in generate-outreach.ts.

export interface EmailDraft {
  profileId:       string;
  companyName:     string;
  xHandle:         string;
  subject:         string;
  body:            string;
  budgetExhausted: boolean;
}

// ── Abstraction ────────────────────────────────────────────────────────────────

export interface IMailSender {
  send(draft: EmailDraft, profile: EnrichedProfile): Promise<boolean>;
}

// ── Mock implementation ────────────────────────────────────────────────────────

const ANSI = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
};

export class MockMailSender implements IMailSender {
  async send(draft: EmailDraft, _profile: EnrichedProfile): Promise<boolean> {
    console.log(
      `${ANSI.cyan}${ANSI.bold}[MockMailSender]${ANSI.reset} ` +
      `Simulating sending email to ${ANSI.bold}${draft.companyName}${ANSI.reset}…`,
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 1_500));

    console.log(
      `${ANSI.green}${ANSI.bold}[MockMailSender]${ANSI.reset} ` +
      `${ANSI.green}Email sent successfully.${ANSI.reset}`,
    );

    return true;
  }
}
