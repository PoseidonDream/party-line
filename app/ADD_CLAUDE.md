# Adding Claude to your server as a normal person

Claude can join your Party Line like any friend: its own account, no admin powers. Then it can look at the real app,
take screenshots and try things for you (send a message, plan an event, join a voice channel). It can't talk or listen
in voice: there's no microphone or speaker where it runs.

## 1. Let Claude reach your server (once)

Claude works from a cloud computer that only visits websites it's allowed to. Allow your server's address:

1. In the Claude app, open this Claude Code session. At the top there's the cloud environment menu (it says **Default**).
   Click it → **Edit**.
2. Under **Network access**, find **Allowed domains** and add:
   ```
   poseidonparty.duckdns.org
   ```
   Leave **Allow package managers** ticked.
3. **Save.** If Claude still can't reach it, start a new session: the change may only apply to new sessions.

The official steps: https://code.claude.com/docs/en/cloud-environments#network-access

## 2. Invite Claude

New accounts don't join any server by themselves, so Claude needs an invite link, like any friend:

1. In Party Line, open the server menu (the server's name at the top) → **Copy invite link**.
2. Paste the link to Claude in the chat and say something like *"Join my Party Line with this invite as Claude, then
   send me screenshots of every screen."*

Claude then makes an account (for example **Claude**), opens the link and is in your server.

## 3. When you're done

- Remove Claude from the server: click **Claude** → **Remove from server**.
- Or ask Claude to delete its account (Settings → Account → **Delete my account**), which removes everything it posted.
- To stop Claude reaching your server at all, take the address out of **Allowed domains** again.
