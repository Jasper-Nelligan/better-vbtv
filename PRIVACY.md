# Privacy Policy for Better VBTV Extension

## Data Collection

The Better VBTV extension does not collect, store, or transmit any personal data
for the developer's benefit. Your spoiler-free preference setting
(enabled/disabled) and your watch history (video titles, thumbnails, and last
playback positions) are saved locally in your browser using Chrome's storage API.

This build additionally synchronises your watch history to a Supabase database
that you own and configure yourself (see Third-Party Services). Your preference
settings are never synchronised and remain local to your device.

## Website Access

This extension only runs on tv.volleyballworld.com. It modifies the visual
display of video durations and player controls to hide spoilers, adds keyboard
controls, and keeps a local watch history. To show a video's title and
thumbnail in that history, the extension requests the video's public metadata
from JW Player's content delivery network (see Third-Party Services below).
No analytics or tracking is implemented, and no personal data is collected.

## Third-Party Services

The settings popup loads its fonts (Geo and Inter) from Google Fonts
(fonts.googleapis.com and fonts.gstatic.com). When the popup opens, your
browser requests these font files from Google's servers, which means Google
may receive standard request metadata such as your IP address and user agent,
as described in Google's privacy policy (https://policies.google.com/privacy).

To build your watch history, the extension fetches each video's title and
poster image from JW Player's public media feed (cdn.jwplayer.com). This
request includes the video's ID — which identifies the replay you are
watching — but no account information, personal details, or other browsing
activity. JW Player may receive standard request metadata such as your IP
address and user agent. This is the same content provider that serves the
video on VBTV itself.

When Supabase credentials are configured at build time, your watch history is
also uploaded to the Supabase project those credentials point at. What is sent
is exactly what the history stores: the video's JW media id, its title, its
thumbnail URL, the player URL, your playback position and the video duration,
and a timestamp. Access is restricted to the single account the extension signs
in as, enforced by row-level security. With no credentials configured, no such
requests are made and history stays on your device.

Aside from the font, video-metadata, and Supabase requests described above, no
personal data, browsing activity, or watch history is ever sent to Google,
JW Player, or any other third party.

## Updates

The extension may be updated through the Chrome Web Store to improve functionality or fix bugs. These updates will never change our no-data-collection policy.

## Contact

For questions or concerns about privacy:
GitHub: @caaatisgood
Last updated: Tue Jun 17 2026
