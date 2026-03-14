import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../index";
import {
  createSupabaseClient,
  searchKnowledgeHybrid,
  logUnansweredQuery,
} from "../lib/supabase";
import { lookupMyOrders, getOrderDetail, type OrderDetailResult } from "../lib/shopify";
import { productCard, productCarousel, orderCard } from "../lib/flex-templates";
import { SYSTEM_PROMPT } from "./system-prompt";
import { AGENT_TOOLS } from "./tools";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type AgentResult = {
  response: string;
  escalated: boolean;
  escalationReason?: string;
  escalationCategory?: string;
  /** Flex Message（商品カード等）。存在する場合はテキストとは別に LINE 送信する */
  flexMessages?: Array<{
    altText: string;
    contents: Record<string, unknown>;
  }>;
  /** Quick Reply ボタン（テキストメッセージに付与） */
  quickReplies?: Array<{ label: string; text: string }>;
};

/** ナレッジ不足と判定する類似度しきい値 */
const LOW_SIMILARITY_THRESHOLD = 0.4;

/** ツールループの最大回数（無限ループ防止） */
const MAX_TOOL_TURNS = 3;

/** ツール実行結果（テキスト + オプションのメタデータ） */
type ToolExecResult = {
  text: string;
  orderDetail?: OrderDetailResult;
};

/**
 * エージェントのメインループ。
 *
 * 1. ハイブリッド検索（ベクトル + キーワード）で関連ナレッジを取得
 * 2. Claude を呼び出し（ツール使用があればループ）
 * 3. エスカレーション・ナレッジ不足検知
 */
export async function runAgent(
  userMessage: string,
  conversationHistory: Message[],
  embedding: number[],
  lineUserId: string,
  env: Env,
): Promise<AgentResult> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const supabase = createSupabaseClient(env);

  // ハイブリッド検索（ベクトル + キーワード）
  const knowledgeResults = await searchKnowledgeHybrid(
    supabase,
    embedding,
    userMessage,
  );

  // ナレッジ不足検知（MS7 7.6）
  const maxSimilarity =
    knowledgeResults.length > 0
      ? Math.max(...knowledgeResults.map((r) => r.similarity))
      : 0;
  const isLowKnowledge =
    knowledgeResults.length === 0 || maxSimilarity < LOW_SIMILARITY_THRESHOLD;

  // 検索結果をコンテキストに組み立て
  let knowledgeContext: string;
  if (knowledgeResults.length > 0) {
    const items = knowledgeResults
      .map(
        (r, i) =>
          `### 検索結果 ${i + 1}（${r.source_type} | 類似度: ${(r.similarity * 100).toFixed(0)}%）\n**${r.source_title}**\n${r.content}`,
      )
      .join("\n\n");
    knowledgeContext = `\n\n## 検索結果（ナレッジベース）\n以下の ${knowledgeResults.length} 件が見つかりました。この情報のみに基づいて回答してください。\n\n${items}`;
  } else {
    knowledgeContext = `\n\n## 検索結果（ナレッジベース）\n該当する情報が見つかりませんでした。「確認してお返事しますね」と伝え、escalate_to_human ツールを使ってください。`;
  }

  // 会話履歴を Claude のメッセージ形式に変換
  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: userMessage },
  ];

  let escalated = false;
  let escalationReason: string | undefined;
  let escalationCategory: string | undefined;
  const flexMessages: Array<{ altText: string; contents: Record<string, unknown> }> = [];
  const usedTools: string[] = [];

  // マルチターンのツールループ
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: SYSTEM_PROMPT + knowledgeContext,
      tools: AGENT_TOOLS,
      messages,
    });

    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // ツール呼び出しがなければ最終応答
    if (toolUseBlocks.length === 0) {
      const finalText = textBlocks.map((b) => b.text).join("");

      // ナレッジ不足を記録
      if (isLowKnowledge) {
        logUnansweredQuery(supabase, {
          lineUserId,
          queryText: userMessage,
          maxSimilarity,
          resultCount: knowledgeResults.length,
          escalated,
        }).catch(console.error);
      }

      const quickReplies = generateQuickReplies(usedTools, escalated);

      return {
        response: finalText || "申し訳ありません、お返事の生成に失敗しました。",
        escalated,
        escalationReason,
        escalationCategory,
        ...(flexMessages.length > 0 ? { flexMessages } : {}),
        ...(quickReplies.length > 0 ? { quickReplies } : {}),
      };
    }

    // ツールを実行
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const execResult = await executeTool(toolUse, lineUserId, env);
      usedTools.push(toolUse.name);

      // 注文確認カード Flex Message 追跡
      if (toolUse.name === "get_order_detail" && execResult.orderDetail?.data) {
        const od = execResult.orderDetail.data;
        flexMessages.push({
          altText: `注文 ${od.orderName} の詳細`,
          contents: orderCard(od),
        });
      }

      // 商品カード Flex Message 追跡
      if (toolUse.name === "recommend_product") {
        const input = toolUse.input as {
          products: Array<{
            name: string;
            description: string;
            price: string;
            product_url: string;
          }>;
        };
        const products = input.products.map((p) => ({
          name: p.name,
          description: p.description,
          price: p.price,
          productUrl: p.product_url,
        }));

        if (products.length === 1) {
          flexMessages.push({
            altText: `商品のご案内: ${products[0].name}`,
            contents: productCard(products[0]),
          });
        } else if (products.length > 1) {
          flexMessages.push({
            altText: `${products.length}件の商品のご案内`,
            contents: productCarousel(products),
          });
        }
      }

      // エスカレーション追跡
      if (toolUse.name === "escalate_to_human") {
        escalated = true;
        const input = toolUse.input as {
          reason: string;
          category: string;
          summary: string;
        };
        escalationReason = input.reason;
        escalationCategory = input.category;
        await notifySlack(
          lineUserId,
          input.reason,
          input.category,
          input.summary,
          env,
        );
      }

      toolResults.push({
        type: "tool_result" as const,
        tool_use_id: toolUse.id,
        content: execResult.text,
      });
    }

    // ツール結果をメッセージに追加してループ
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  // ループ上限に達した場合のフォールバック
  if (isLowKnowledge) {
    logUnansweredQuery(supabase, {
      lineUserId,
      queryText: userMessage,
      maxSimilarity,
      resultCount: knowledgeResults.length,
      escalated,
    }).catch(console.error);
  }

  return {
    response: "スタッフに確認いたしますので、少々お待ちくださいね。",
    escalated,
    escalationReason,
    escalationCategory,
    ...(flexMessages.length > 0 ? { flexMessages } : {}),
  };
}

/**
 * 使用ツール・状況に応じた Quick Reply を生成（MS5 5.5）。
 * LINE の Quick Reply は最大13個まで。
 */
function generateQuickReplies(
  usedTools: string[],
  escalated: boolean,
): Array<{ label: string; text: string }> {
  if (escalated) {
    return [
      { label: "はい、お待ちします", text: "はい、お待ちしています" },
    ];
  }

  if (usedTools.includes("recommend_product")) {
    return [
      { label: "詳しく教えて", text: "この商品についてもっと詳しく教えてください" },
      { label: "他の商品も見たい", text: "他のおすすめ商品も教えてください" },
      { label: "購入方法は？", text: "購入方法を教えてください" },
    ];
  }

  if (usedTools.includes("get_order_detail") || usedTools.includes("lookup_my_orders")) {
    return [
      { label: "配送状況を確認", text: "配送状況を詳しく教えてください" },
      { label: "他の注文も確認", text: "他の注文も確認したいです" },
    ];
  }

  // ツール未使用（通常の回答）の場合は Quick Reply なし
  return [];
}

/**
 * ツールの実行。
 * ツール名に応じて対応する関数を呼び出す。
 */
async function executeTool(
  toolUse: Anthropic.ToolUseBlock,
  lineUserId: string,
  env: Env,
): Promise<ToolExecResult> {
  try {
    switch (toolUse.name) {
      case "escalate_to_human":
        return { text: "オペレーターに通知しました。" };

      case "lookup_my_orders":
        return { text: await lookupMyOrders(lineUserId, env) };

      case "get_order_detail": {
        const input = toolUse.input as { order_number: string };
        const orderResult = await getOrderDetail(input.order_number, env);
        return { text: orderResult.text, orderDetail: orderResult };
      }

      case "recommend_product":
        return { text: "商品カードを送信しました。テキストでも簡潔に商品を紹介してください。" };

      default:
        return { text: `不明なツール: ${toolUse.name}` };
    }
  } catch (error) {
    console.error(`Tool execution error (${toolUse.name}):`, error);
    return { text: `ツールの実行中にエラーが発生しました。お客様には「確認してお返事します」と伝えてください。` };
  }
}

/** カテゴリの日本語ラベル */
const CATEGORY_LABELS: Record<string, string> = {
  knowledge_gap: "ナレッジ不足",
  complaint: "クレーム・返品",
  human_request: "人間対応要求",
  health_safety: "健康・安全",
  personal_info: "個人情報確認",
  order_trouble: "注文トラブル",
  uncertain: "回答不確実",
};

/** Slack にエスカレーション通知を送信 */
async function notifySlack(
  lineUserId: string,
  reason: string,
  category: string,
  summary: string,
  env: Env,
): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) {
    console.warn("SLACK_WEBHOOK_URL is not set, skipping notification");
    return;
  }

  const categoryLabel = CATEGORY_LABELS[category] ?? category;

  const payload = {
    text: `🚨 *エスカレーション* [${categoryLabel}]\n\n*LINE User:* ${lineUserId}\n*分類:* ${categoryLabel}\n*理由:* ${reason}\n*会話要約:* ${summary}`,
  };

  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error("Slack notification failed:", await res.text());
  }
}
