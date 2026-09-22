# AI HACK team instructions

Use the pinned AWS development workflow with Codex. Read README.md,
docs/AI_DLC_SETUP.md and docs/event/ before starting.
Follow the setup instructions in README.md once on each member's machine.
The setup preserves this team block and adds the official workflow instructions.

The selected product uses Even G2 to research people and companies mentioned in conversation and display source-backed topic cards. The service name is undecided. Reuse the existing glasses connection approach documented in docs/EVEN_G2_INTEGRATION.md.
The user confirmed the presented requirements and delegated code review and merging on 2026-09-22; read docs/DECISIONS.md. Use docs/specs/ as the accepted development baseline, with unresolved inputs recorded separately. Continue routine implementation, review, checks and merges without asking the same questions again. Do not invent official workflow approvals or verified device results.
Separate sourced facts from conversation suggestions. Resolve ambiguous identity before combining personal facts.
Use GitHub Issues and pull requests to connect requirements, implementation, and verification.
Keep secrets and real personal data out of the public repository. Record actual results; do not claim unrun tests passed.

Non-negotiable user constraints (reaffirmed 2026-09-22): follow docs/event/RULES_AND_SUBMISSION.md in every design, implementation, verification and submission decision. The product must autonomously carry out conversation-time person/company research and topic preparation: decide what to investigate, use available sources, check evidence, then continue, discard, recover or stop according to the result. Document and measure what the AI does and where a person intervenes.
Preserve evidence for security, cost performance, reliability/recovery, autonomy/human intervention and originality. The five-axis grouping is provisional; do not invent a confirmed scoring breakdown. Reduce optional features before dropping these checks or submission work.
Submission requires public source/repository, a demo video no longer than 180 seconds, and a Qiita/Zenn article naming AI HACK and describing actual OrcaRouter use, submitted via the Google form by September 22 at 15:00. Keep unknown form URL/year/timezone explicit. Prepare a 4-minute final presentation and 3-minute Q&A. Do not mark the project submission-ready while any mandatory evidence or deliverable is missing.

Team adaptation: each member uses their existing Codex login and model. The setup script removes the upstream Bedrock and model pins only from newly generated configuration. Descriptions of shipped defaults in generated instructions refer to upstream, not this adaptation.
