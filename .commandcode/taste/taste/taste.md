# Taste
- Prefers a plan to be created and reviewed before executing an investigation or feature ("create plan for investigate this", then "ok execute the plan"). Confidence: 0.7
- Delivers changes through pull requests; expects conflicts to be resolved and all PR review comments to be addressed, explicitly directing work against the latest commit (e.g., "address new comment based latest commit on #143", "address all PR comments on #144"). Confidence: 0.95
- Wants completed work committed and pushed to the feature branch rather than left uncommitted; responds to "want me to commit and push?" with a terse go-ahead ("commit and push it all") and expects all staged changes to be included. Confidence: 0.7
- Bumps the version (e.g., to 0.1.4) as part of the release workflow for changes. Confidence: 0.5
- Prefers incremental scope: keep single-agent / single-wallet operation until the system is proven profitable before expanding to multi-agent/multi-wallet features. Confidence: 0.6
- Wants system behavior verified against the live running system (e.g., via SSH and the jup CLI to confirm behavior matches onchain) rather than trusting code alone. Confidence: 0.6
- Before changing code in response to a review comment, traces the intended design (git history, PR body, original commits, tests) to determine whether the comment reflects a real bug or intentional design; leaves code unchanged when it is correct by design and explains why rather than force-fitting the reviewer's suggested fix. Confidence: 0.6
- Uses a structured conventional-commit message with a detailed body grouping changes by area (engine, API worker, migration/tests) when committing PR review fixes. Confidence: 0.5
