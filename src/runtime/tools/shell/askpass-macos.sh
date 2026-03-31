#!/bin/bash
# Koi sudo askpass helper — macOS
# Shows a native system dialog to request the sudo password.
#
# All display texts are passed as env vars by shell.js (already i18n-resolved):
#   KOI_SUDO_TITLE   — dialog window title
#   KOI_SUDO_HEADER  — bold header line
#   KOI_SUDO_RLABEL  — "Reason" label
#   KOI_SUDO_REASON  — why sudo is needed (from the LLM's description)

TITLE="${KOI_SUDO_TITLE:-Koi — administrator privileges}"
HEADER="${KOI_SUDO_HEADER:-Koi needs administrator access}"
RLABEL="${KOI_SUDO_RLABEL:-Reason}"
REASON="${KOI_SUDO_REASON:-A command requires administrator privileges.}"

osascript <<EOT
tell application "System Events"
    activate
    set userPassword to text returned of (display dialog "🔒 ${HEADER}

${RLABEL}: ${REASON}" default answer "" with hidden answer buttons {"Cancel", "OK"} default button "OK" with title "${TITLE}" with icon caution)
    return userPassword
end tell
EOT
