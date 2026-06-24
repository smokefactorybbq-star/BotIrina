import express from "express";
import http from "http";
import crypto from "crypto";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import FormData from "form-data";

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "agentbot";
const AGENT_URL = process.env.AGENT_URL;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");
if (!PUBLIC_URL) throw new Error("PUBLIC_URL is not set");
if (!AGENT_URL) throw new Error("AGENT_URL is not set");

const bot = new Telegraf(BOT_TOKEN);

let orders = [];
const mediaGroups = new Map();
const pendingByChat = new Map();

function pruneOrders() {
  const now = Date.now();
  orders = orders.filter((o) => o.expiresAt > now);
  orders.sort((a, b) => b.createdAt - a.createdAt);
  orders = orders.slice(0, 10);
}

function addKitchenOrder(orderNo, prepMinutes, items = [], cutlery = null) {
  const createdAt = Date.now();
  const endsAt = createdAt + prepMinutes * 60_000;
  const expiresAt = endsAt + 5 * 60_000;

  const order = {
    id: crypto.randomUUID(),
    orderNo,
    prepMinutes,
    createdAt,
    endsAt,
    expiresAt,
    cutlery,
    items,
  };

  orders.unshift(order);
  pruneOrders();

  return order;
}

const app = express();
app.use(express.json({ limit: "20mb" }));

app.get("/api/orders", (_req, res) => {
  pruneOrders();
  res.setHeader("Cache-Control", "no-store");
  res.json(orders);
});

app.get("/", (_req, res) => {
  res.redirect("/screen");
});

app.get("/screen", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(`
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kitchen Screen</title>
<style>
body{margin:0;background:#050813;color:white;font-family:Arial,sans-serif;overflow:hidden}
.stage{padding:40px}
.grid{display:grid;grid-template-columns:repeat(5,1fr);grid-template-rows:repeat(2,calc((100vh - 90px)/2));gap:10px}
.card{background:#0f1730;border:1px solid rgba(255,255,255,.15);border-radius:18px;padding:14px;overflow:hidden}
.top{display:flex;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.15);padding-bottom:10px;margin-bottom:10px}
.no,.timer{font-size:28px;font-weight:900}
.cutlery{font-size:17px;font-weight:900;margin-bottom:8px}
.item{display:flex;justify-content:space-between;font-size:21px;font-weight:800;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.08)}
.empty{display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,.25);font-size:30px;font-weight:900}
.ready{color:#aaa}.green{color:#00ff66}.yellow{color:#ffd400}.red{color:#ff3b30}
</style>
</head>
<body>
<div class="stage"><div class="grid" id="grid"></div></div>
<script>
const grid=document.getElementById("grid");
function pad(n){return String(n).padStart(2,"0")}
function remainText(endsAt){const ms=endsAt-Date.now();if(ms<=0)return"READY";const s=Math.floor(ms/1000);return Math.floor(s/60)+":"+pad(s%60)}
function colorClass(endsAt){const min=(endsAt-Date.now())/60000;if(min<=0)return"ready";if(min<=10)return"red";if(min<=25)return"yellow";return"green"}
function escapeHtml(s){return String(s||"").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
function cutleryText(v){if(v===true)return'<div class="cutlery green">Cutlery required</div>';if(v===false)return'<div class="cutlery red">Dont need cutlery</div>';return""}
function render(orders){
  grid.innerHTML="";
  for(let i=0;i<10;i++){
    const o=orders[i];
    const card=document.createElement("div");
    card.className="card";
    if(!o){card.innerHTML='<div class="empty">—</div>';grid.appendChild(card);continue}
    const items=(o.items||[]).map(it=>'<div class="item"><span>'+escapeHtml(it.name)+'</span><span>x'+it.qty+'</span></div>').join("");
    card.innerHTML='<div class="top"><div class="no">'+escapeHtml(o.orderNo)+'</div><div class="timer '+colorClass(o.endsAt)+'">'+remainText(o.endsAt)+'</div></div>'+cutleryText(o.cutlery)+items;
    grid.appendChild(card);
  }
}
async function load(){try{const r=await fetch("/api/orders",{cache:"no-store"});const data=await r.json();render(data||[])}catch(e){console.error(e)}}
setInterval(load,1000);load();
</script>
</body>
</html>
`);
});

bot.start(async (ctx) => {
  await ctx.reply(
    "Готов. Отправь 1–3 скриншота одного заказа одним сообщением/альбомом.\n\nПосле фото я спрошу время приготовления."
  );
});

async function askTime(ctx, fileIds) {
  const chatId = ctx.chat.id;

  pendingByChat.set(chatId, {
    fileIds: fileIds.slice(0, 3),
    createdAt: Date.now(),
  });

  await ctx.reply(
    "⏱ Сколько минут готовить заказ?\n\nНапиши только число, например: 25"
  );
}

async function sendToAgentAndScreen(ctx, fileIds, prepMinutes) {
  await ctx.reply("⏳ Отправляю скриншоты Windows Agent...");

  const form = new FormData();

  for (let i = 0; i < fileIds.length; i++) {
    const fileLink = await ctx.telegram.getFileLink(fileIds[i]);
    const imageResponse = await fetch(fileLink.href);
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

    form.append("screenshots", imageBuffer, {
      filename: `screenshot_${i + 1}.jpg`,
      contentType: "image/jpeg",
    });
  }

  const agentResponse = await fetch(AGENT_URL, {
    method: "POST",
    body: form,
    headers: {
      ...form.getHeaders(),
      "ngrok-skip-browser-warning": "true",
    },
  });

  const agentText = await agentResponse.text();

  let data;
  try {
    data = JSON.parse(agentText);
  } catch {
    await ctx.reply(
      "❌ Агент вернул не JSON.\n\nHTTP status: " +
      agentResponse.status +
      "\n\n" +
      agentText.slice(0, 1500)
    );
    return;
  }

  if (data.status !== "ok") {
    await ctx.reply(
      "❌ Windows Agent не смог распознать заказ.\n\n" +
      JSON.stringify(data, null, 2).slice(0, 3000)
    );
    return;
  }

  const orderNo = data.order_number || data.orderNo || "SCREENSHOT";
  const cutlery = data.cutlery;
  const rawItems = data.items || [];

  const items = rawItems.map((it) => ({
    name: it.name || String(it),
    qty: Number(it.qty || 1),
  }));

  if (!items.length) {
    await ctx.reply("❌ Агент не нашёл позиции заказа.");
    return;
  }

  addKitchenOrder(orderNo, prepMinutes, items, cutlery);

  await ctx.reply(
    "✅ Заказ отправлен на экран кухни.\n\n" +
    "№: " + orderNo + "\n" +
    "Время: " + prepMinutes + " мин\n" +
    "Приборы: " +
    (cutlery === true ? "нужны" : cutlery === false ? "не нужны" : "не указано") +
    "\n\nСостав:\n" +
    items.map((i) => "• " + i.name + " x" + i.qty).join("\n") +
    "\n\nЭкран:\n" +
    PUBLIC_URL + "/screen"
  );
}

bot.on("photo", async (ctx) => {
  try {
    const photos = ctx.message.photo || [];
    const bestPhoto = photos[photos.length - 1];

    if (!bestPhoto) {
      await ctx.reply("❌ Фото не найдено.");
      return;
    }

    const mediaGroupId = ctx.message.media_group_id;

    if (mediaGroupId) {
      if (!mediaGroups.has(mediaGroupId)) {
        mediaGroups.set(mediaGroupId, {
          ctx,
          fileIds: [],
          timer: null,
        });
      }

      const group = mediaGroups.get(mediaGroupId);
      group.fileIds.push(bestPhoto.file_id);

      if (group.timer) clearTimeout(group.timer);

      group.timer = setTimeout(async () => {
        const savedGroup = mediaGroups.get(mediaGroupId);
        mediaGroups.delete(mediaGroupId);

        if (!savedGroup) return;

        await askTime(savedGroup.ctx, savedGroup.fileIds);
      }, 2500);

      return;
    }

    await askTime(ctx, [bestPhoto.file_id]);

  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Ошибка при получении фото:\n" + String(e.message || e));
  }
});

bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  const pending = pendingByChat.get(chatId);

  if (!pending) {
    await ctx.reply("Отправь скриншот заказа.");
    return;
  }

  const txt = String(ctx.message.text || "").trim();
  const prepMinutes = Number(txt);

  if (!Number.isFinite(prepMinutes) || prepMinutes < 1 || prepMinutes > 240) {
    await ctx.reply("Введите время числом от 1 до 240. Например: 25");
    return;
  }

  pendingByChat.delete(chatId);

  try {
    await sendToAgentAndScreen(ctx, pending.fileIds, Math.floor(prepMinutes));
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Ошибка:\n" + String(e.message || e));
  }
});

const WEBHOOK_PATH = "/tg/" + WEBHOOK_SECRET;

app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    await bot.handleUpdate(req.body, res);
    if (!res.headersSent) res.sendStatus(200);
  } catch (e) {
    console.error("HANDLE UPDATE ERROR:", e);
    if (!res.headersSent) res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;

http.createServer(app).listen(PORT, async () => {
  console.log("Listening on", PORT);

  const webhookUrl = PUBLIC_URL + WEBHOOK_PATH;

  await bot.telegram.setWebhook(webhookUrl, {
    drop_pending_updates: true,
  });

  console.log("Webhook set:", webhookUrl);
});
