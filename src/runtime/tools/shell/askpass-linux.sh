#!/bin/bash
# Koi sudo askpass helper — Linux
# Shows a GUI dialog to request the sudo password.
# Tries zenity (GTK/GNOME), then kdialog (KDE), then ssh-askpass.
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
PROMPT="🔒 ${HEADER}\n\n${RLABEL}: ${REASON}"

if command -v zenity >/dev/null 2>&1; then
    zenity --password --title="$TITLE" --text="$PROMPT" 2>/dev/null
elif command -v kdialog >/dev/null 2>&1; then
    kdialog --title "$TITLE" --password "$PROMPT" 2>/dev/null
elif command -v ssh-askpass >/dev/null 2>&1; then
    SSH_ASKPASS_PROMPT=confirm ssh-askpass "$PROMPT" 2>/dev/null
else
    echo "No GUI askpass program found (zenity, kdialog, ssh-askpass)" >&2
    exit 1
fi
