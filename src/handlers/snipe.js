/**
 * Snipe + EditSnipe handlers.
 *
 * Tracks:
 *   messageDelete  → snipeStore.deleted  (last deleted msg per channel)
 *   messageUpdate  → snipeStore.edited   (last edited msg per channel)
 *
 * Commands:
 *   snipe      — show last deleted message in the current channel
 *   editsnipe  — show last edited message in the current channel
 */

// ── In-memory storage (cleared on restart — intentional) ──────────────────
export const snipeStore = {
  /** @type {Map<string, {content:string, author:object, timestamp:Date, attachments:string[]}>} */
  deleted: new Map(),
  /** @type {Map<string, {before:string, after:string, author:object, timestamp:Date}>} */
  edited:  new Map(),
};

// ── Event trackers (called from bot.js listeners) ──────────────────────────

export function trackDeletedMessage(message) {
  // Ignore empty messages and bots
  if (!message.content && !message.attachments?.size) return;
  if (message.author?.bot) return;

  snipeStore.deleted.set(message.channel.id, {
    content:     message.content || '',
    author:      message.author,
    timestamp:   message.createdAt,
    attachments: [...(message.attachments?.values() ?? [])].map(a => a.url),
  });
}

export function trackEditedMessage(oldMessage, newMessage) {
  if (!oldMessage.content && !newMessage.content) return;
  if (oldMessage.content === newMessage.content)  return;
  if (newMessage.author?.bot) return;

  snipeStore.edited.set(newMessage.channel.id, {
    before:    oldMessage.content || '',
    after:     newMessage.content || '',
    author:    newMessage.author,
    timestamp: newMessage.editedAt ?? newMessage.createdAt,
  });
}

// ── Command handlers ───────────────────────────────────────────────────────

export async function cmdSnipe(bot, message) {
  const data = snipeStore.deleted.get(message.channel.id);
  if (!data) {
    return message.channel.send(
      '❌ No recently deleted messages recorded in this channel.',
    );
  }

  const username = data.author?.tag ?? data.author?.username ?? 'Unknown';
  const tsUnix   = Math.floor(new Date(data.timestamp).getTime() / 1000);
  const lines    = [
    `🗑️ **Last deleted message** — <t:${tsUnix}:R>`,
    `**Author:** ${username}`,
    `**Content:** ${data.content || '*(no text)*'}`,
  ];
  if (data.attachments?.length) {
    lines.push(`**Attachments:** ${data.attachments.join(' ')}`);
  }
  return message.channel.send(lines.join('\n'));
}

export async function cmdEditSnipe(bot, message) {
  const data = snipeStore.edited.get(message.channel.id);
  if (!data) {
    return message.channel.send(
      '❌ No recently edited messages recorded in this channel.',
    );
  }

  const username = data.author?.tag ?? data.author?.username ?? 'Unknown';
  const tsUnix   = Math.floor(new Date(data.timestamp).getTime() / 1000);
  return message.channel.send(
    [
      `✏️ **Last edited message** — <t:${tsUnix}:R>`,
      `**Author:** ${username}`,
      `**Before:** ${data.before || '*(empty)*'}`,
      `**After:**  ${data.after  || '*(empty)*'}`,
    ].join('\n'),
  );
}
