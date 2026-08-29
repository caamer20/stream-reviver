# Roadmap and release gates

The 3.1 codebase is a release candidate when automated gates pass. Stable distribution additionally requires:

- a completed 24-hour browser soak with no extension errors, runaway memory growth, false reloads, or stuck discard protection;
- a representative private beta of at least 20 consenting users or 500 monitored hours, with opt-in, manually exported aggregate results;
- independent security/privacy review of permissions, messaging, page-world instrumentation, and data deletion;
- signed Chrome Web Store and Firefox Add-ons packages and reviewer approval;
- a public privacy-policy URL and maintained support/reporting channel;
- localized UI beyond the shipped English source when audience demand is established.

Future work should be driven by measured false positives and recoveries, not an unsupported universal success-rate claim.
