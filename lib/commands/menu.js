"use strict";

const { getPrefix, getBotName, getNsfwEnabled } = require("../runtime-settings");
const { sendReact } = require("../utils");
const themeMgr = require("../theme-manager");
const { sendBannerMessage } = require("../media-fallback");

module.exports = {
  name: "menu",
  aliases: ["help", "allmenu", "commands", "list", "start"],
  description: "Bot command menu",
  category: "system",

  async execute(sock, msg, from, args, name, context) {
    const participant = msg.key.participant || msg.key.remoteJid || from;
    const ownerRefs = context.owner ? [context.owner] : [];
    const tCtx = { sender: participant, ownerRefs };

    await sendReact(sock, from, msg, "📜");

    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);

    const prefix = context.prefix || getPrefix();
    const botName = context.botName || getBotName();

    let fullMenu = themeMgr.format("header", { title: botName.toUpperCase() }, tCtx);
    fullMenu += "\n";
    fullMenu += themeMgr.format("section", { title: "ᴘʀᴏғɪʟᴇ" }, tCtx);
    fullMenu += themeMgr.format("item", { bullet: "user", content: `ᴜsᴇʀ   : @${participant.split('@')[0]}` }, tCtx);
    fullMenu += themeMgr.format("item", { bullet: "default", content: `ᴘʀᴇғɪx : 「 ${prefix} 」` }, tCtx);
    fullMenu += themeMgr.format("item", { bullet: "default", content: `ᴜᴘᴛɪᴍᴇ : ${h}h ${m}m` }, tCtx);
    fullMenu += themeMgr.format("footer", {}, tCtx);
    fullMenu += "\n";

    // --- DOWNLOADERS ---
    fullMenu += themeMgr.format("box_start", { title: "📥 ᴅᴏᴡɴʟᴏᴀᴅᴇʀs" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}yt · ${prefix}yta · ${prefix}tt` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}ig · ${prefix}fb · ${prefix}play` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}song · ${prefix}video · ${prefix}playvideo` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- SEARCH ---
    fullMenu += themeMgr.format("box_start", { title: "🔍 sᴇᴀʀᴄʜ & ɪɴғᴏ" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "search", content: `${prefix}yts · ${prefix}google · ${prefix}wiki` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "search", content: `${prefix}weather · ${prefix}imdb · ${prefix}news` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "search", content: `${prefix}github · ${prefix}reddit · ${prefix}pinsearch` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "search", content: `${prefix}lyrics` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- AI ---
    fullMenu += themeMgr.format("box_start", { title: "🤖 ᴀɪ ᴄᴏɴᴛʀᴏʟ" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "creative", content: `${prefix}ai · ${prefix}chat · ${prefix}tts` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "creative", content: `${prefix}trt · ${prefix}translate · ${prefix}img` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- ADULT (only shown when NSFW is explicitly enabled by the owner) ---
    const nsfwEnabled = (context.nsfwEnabled !== undefined)
      ? !!context.nsfwEnabled
      : getNsfwEnabled();
    if (nsfwEnabled) {
      fullMenu += themeMgr.format("box_start", { title: "🔞 ᴀᴅᴜʟᴛ ᴢᴏɴᴇ" }, tCtx);
      fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}ph · ${prefix}xnxx · ${prefix}xv · ${prefix}xh` }, tCtx);
      fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}yp · ${prefix}sb · ${prefix}rt · ${prefix}boobs` }, tCtx);
      fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}ass · ${prefix}waifu · ${prefix}blowjob` }, tCtx);
      fullMenu += themeMgr.format("box_end", {}, tCtx);
      fullMenu += "\n";
    }

    // --- GAMES ---
    fullMenu += themeMgr.format("box_start", { title: "🎮 ɢᴀᴍᴇs ᴢᴏɴᴇ" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}8ball · ${prefix}truth · ${prefix}dare` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}tord · ${prefix}rps · ${prefix}ship` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}lovecalc · ${prefix}roast · ${prefix}rate` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "default", content: `${prefix}compliment` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- GROUP ---
    fullMenu += themeMgr.format("box_start", { title: "🛡️ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴ" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "group", content: `${prefix}kick · ${prefix}add · ${prefix}promote` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "group", content: `${prefix}demote · ${prefix}lock · ${prefix}unlock` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "group", content: `${prefix}antilink · ${prefix}welcome` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "group", content: `${prefix}goodbye · ${prefix}nsfw` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- ECONOMY ---
    fullMenu += themeMgr.format("box_start", { title: "💰 ᴇᴄᴏɴᴏᴍʏ" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "economy", content: `${prefix}bal · ${prefix}daily · ${prefix}shop` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "economy", content: `${prefix}buy · ${prefix}transfer · ${prefix}work` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- FUN ---
    fullMenu += themeMgr.format("box_start", { title: "🎈 ғᴜɴ & ᴊᴏᴋᴇs" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "fun", content: `${prefix}joke · ${prefix}meme · ${prefix}fact` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "fun", content: `${prefix}inspire · ${prefix}quote · ${prefix}roll · ${prefix}flip` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- USER ---
    fullMenu += themeMgr.format("box_start", { title: "👤 ᴜsᴇʀ ᴄᴇɴᴛᴇʀ" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "user", content: `${prefix}profile · ${prefix}pp · ${prefix}bio` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "user", content: `${prefix}vcard · ${prefix}sticker · ${prefix}myinfo` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- SYSTEM ---
    fullMenu += themeMgr.format("box_start", { title: "⚙️ sʏsᴛᴇᴍ ᴏᴘs" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "system", content: `${prefix}ping · ${prefix}alive · ${prefix}ss` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "system", content: `${prefix}status · ${prefix}autoview · ${prefix}autostatus` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "system", content: `${prefix}settings · ${prefix}theme · ${prefix}mode` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "system", content: `${prefix}pair · ${prefix}remind` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);
    fullMenu += "\n";

    // --- OWNER ---
    fullMenu += themeMgr.format("box_start", { title: "👑 ᴏᴡɴᴇʀ ᴘᴀɴᴇʟ" }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "owner", content: `${prefix}reload · ${prefix}update · ${prefix}broadcast` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "owner", content: `${prefix}ban · ${prefix}unban · ${prefix}listban` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "owner", content: `${prefix}block · ${prefix}unblock · ${prefix}listblock` }, tCtx);
    fullMenu += themeMgr.format("box_item", { bullet: "owner", content: `${prefix}setowner · ${prefix}addowner · ${prefix}delowner` }, tCtx);
    fullMenu += themeMgr.format("box_end", {}, tCtx);

    fullMenu += themeMgr.getSignature(participant, ownerRefs);

    await sendBannerMessage(sock, from, {
      caption: fullMenu,
      text: fullMenu,
      mentions: [participant],
      contextInfo: { isForwarded: true, forwardingScore: 999 },
      quoted: msg,
    });

    await sendReact(sock, from, msg, "✅");
  },
};
