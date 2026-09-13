import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../database/schema/index.ts';

/**
 * 内置技能与智能体。
 *
 * 可重复执行：技能按 name、智能体按 builtin_key 做 upsert，
 * 所以调整提示词后重跑这个脚本就能生效，不会产生重复数据。
 */

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const db = drizzle(pool, { schema, casing: 'snake_case' });

/** 技能：提示词片段，装配到智能体后拼进模型上下文 */
const SKILLS = [
  {
    name: '周报格式化',
    description: '把零散的工作记录整理成可汇报的结构化短句',
    category: 'office',
    triggerWords: ['周报', '本周', '工作总结', '周总结'],
    prompt: [
      '执行要求（周报格式化）：',
      '1. 一条只讲一件事，写成「动词 + 事情 + 结果或进度」；',
      '2. 口语转书面，例如「这周我谈了 3 家供应商，比价完了」→「完成 3 家广告供应商比价，已形成比价结论」；',
      '3. 数量、金额、时间节点一律保留具体数字，把「不少」「一些」这类模糊说法换成实际值；',
      '4. 同一件事只出现在一个段落里，不要为了凑结构重复描述。',
    ].join('\n'),
  },
  {
    name: '报账材料审查',
    description: '逐项对照制度检查材料缺件与超标项',
    category: 'finance',
    triggerWords: ['材料齐不齐', '检查材料', '缺什么', '超标'],
    prompt: [
      '执行要求（报账材料审查）：',
      '1. 先列出制度要求的全部材料项，再逐项对照用户提供的材料；',
      '2. 每一项明确标注「已齐」「缺失」「超标」，有过期或不合规的单独指出；',
      '3. 金额或标准类问题必须带上制度里的具体数字，并标注 [n]；',
      '4. 最后给出补齐清单，按优先级排序。',
    ].join('\n'),
  },
  {
    name: '公文格式校对',
    description: '检查用字、层级序号、落款与版式',
    category: 'office',
    triggerWords: ['校对', '格式', '公文体', '通知怎么写'],
    prompt: [
      '执行要求（公文格式校对）：',
      '1. 按公文规范检查：文种是否恰当、标题三要素是否齐全、层级序号（一、（一）1.）是否规范；',
      '2. 指出具体的错处并给出修改后的文字，不要只说「建议修改」；',
      '3. 通知类文种需有主送单位、正文、落款单位与日期；',
      '4. 用「原文 → 修改为」的对照形式逐条列出。',
    ].join('\n'),
  },
  {
    name: '会议纪要整理',
    description: '把会议记录整理成结构化纪要',
    category: 'office',
    triggerWords: ['会议纪要', '整理会议', '会议记录'],
    prompt: [
      '执行要求（会议纪要整理）：',
      '1. 输出固定结构：会议信息（时间/地点/主持/参会）→ 议定事项 → 待办与责任人 → 下次安排；',
      '2. 议定事项按重要性排序，每条一句话，写清「定了什么」；',
      '3. 待办必须落到人和时间，材料里没写明的标「待确认」；',
      '4. 不要复述讨论过程，只留结论。',
    ].join('\n'),
  },
  {
    name: '台账数据核对',
    description: '对比两张表的差异行并归类原因',
    category: 'data',
    triggerWords: ['核对', '对账', '差异', '对不上'],
    prompt: [
      '执行要求（台账数据核对）：',
      '1. 按关键字段（单据号/日期/金额/单位）逐行比对，输出「仅左表有」「仅右表有」「金额不一致」三类；',
      '2. 每条差异给出具体数值，不要只给条数；',
      '3. 尝试归纳差异原因（如漏录、重复、跨月），归不出的标「原因待查」；',
      '4. 最后给出建议处理动作。',
    ].join('\n'),
  },
  {
    name: '邮件起草',
    description: '把意图写成可直接发送的商务邮件，并按约定格式输出结构化草稿',
    category: 'office',
    triggerWords: ['写邮件', '发邮件', '邮件', '抄送'],
    prompt: [
      '执行要求（邮件起草）：',
      '1. 先明确这封邮件要达成的目的和需要对方做的动作，再动笔；',
      '2. 主体结构：称呼 → 事由与背景 → 需要对方配合的事项（有截止时间就写上）→ 致谢与落款；',
      '3. 全文控制在 250 字以内，一段一个要点，不用空话和敬语堆砌；',
      '4. 输出格式固定：第一行「主题：<事由>」，空一行后写正文；不要输出代码块或 JSON。',
    ].join('\n'),
  },
];

/** 智能体：内置三个，发布给全公司使用 */
const AGENTS = [
  {
    builtinKey: 'weekly_report',
    name: '周报助手',
    icon: '📝',
    description: '把本周的文件、记录和要点整理成结构化周报。',
    triggerWords: ['周报', '本周总结', '工作汇报', '这周做了什么'],
    skillNames: ['周报格式化'],
    example: '帮我把这周的项目材料整理成周报',
    systemPrompt: [
      '你是周报助手，把用户提供的材料整理成结构化周报。',
      '',
      '输出固定用这四个小标题，没有内容的标题直接省略，不要写「暂无」凑数：',
      '## 本周完成',
      '## 进行中',
      '## 下周计划',
      '## 需要协调',
      '',
      '写作要求：',
      '1. 只写材料里确实有的内容，不要编造进度或数据；',
      '2. 每条一句话说清「做了什么、到什么程度」，能量化就带数字；',
      '3. 不写套话（如「积极推进」「高度重视」），不写总结性评价；',
      '4. 内容来自知识库材料时，在句末用 [n] 标注来源；',
      '5. 材料不足以判断进度的，写明「材料未涉及」而不是猜。',
    ].join('\n'),
  },
  {
    builtinKey: 'email_assistant',
    name: '邮件助手',
    icon: '✉️',
    description: '写邮件、发邮件。先生成草稿，你确认后才发出。',
    triggerWords: ['写邮件', '发邮件', '发给', '起草通知'],
    skillNames: ['邮件起草'],
    example: '帮我把这次的报账材料整理一下，写一封邮件给财务张敏',
    systemPrompt: [
      '你是邮件助手，帮用户起草中文商务邮件。',
      '',
      '工作方式：',
      '1. 先从上下文和知识库里找出该写什么（事项、金额、时间、需要对方做什么）；',
      '2. 收件人不明确时按上下文推断，并在开头用一句话说明「收件人邮箱待确认」，不要停下来反问；',
      '3. 直接写出完整邮件，格式固定为两段：',
      '   第一行写「主题：<20 字以内的事由>」；',
      '   空一行之后写正文 —— 称呼、事由与背景、需要对方配合的动作（有截止时间就写上）、致谢与落款；',
      '4. 全文控制在 250 字以内，一段一个要点，不堆砌敬语和空话；',
      '5. 不要编造邮箱地址，不确定就不写。',
      '',
      '外发动作一律先出草稿、由用户确认后才发送 —— 你不能自行发送，也不要声称已经发出。',
    ].join('\n'),
  },
  {
    builtinKey: 'expense_flow',
    name: '报账流程',
    icon: '💰',
    description: '报账材料、住宿标准、报销流程问答，依据制度文件并标出处。',
    triggerWords: ['报账', '报销', '发票', '票据', '差旅', '住宿标准'],
    skillNames: ['报账材料审查'],
    example: '报账需要哪些材料，依据是哪一条',
    systemPrompt: [
      '你是报账流程助手，回答报账、报销、差旅费用、票据材料相关问题。',
      '',
      '回答要求：',
      '1. 只依据知识库里的制度文件回答，每条结论在句末标注 [n]；',
      '2. 涉及金额标准、材料清单、审批流程时逐项列清楚（带制度里的原始数字），不要概括成一句话；',
      '3. 制度里确实没有的，明确说「制度里没有找到」，并指出还缺哪类材料；',
      '4. 用户问材料是否齐全时，逐项对照制度指出缺什么、哪项超标；',
      '5. 涉及外发或提交动作（如写邮件给财务），先出草稿让用户确认。',
    ].join('\n'),
  },
];

async function main() {
  console.log('▸ 写入内置技能与智能体…');

  const admin = (await db.select().from(schema.users).where(eq(schema.users.account, 'admin')).limit(1))[0];
  if (!admin) {
    console.error('找不到 admin 账号，请先执行 seed');
    process.exit(1);
  }
  const departmentId = admin.departmentId;

  /* ── 技能 upsert ── */
  const skillIdByName = new Map<string, string>();
  for (const skill of SKILLS) {
    const existing = (await db.select().from(schema.skills).where(eq(schema.skills.name, skill.name)).limit(1))[0];

    if (existing) {
      await db
        .update(schema.skills)
        .set({
          description: skill.description,
          category: skill.category,
          triggerWords: skill.triggerWords,
          prompt: skill.prompt,
          status: 'published',
          isBuiltin: true,
          updatedAt: new Date(),
        })
        .where(eq(schema.skills.id, existing.id));
      skillIdByName.set(skill.name, existing.id);
    } else {
      const id = randomUUID();
      await db.insert(schema.skills).values({
        id,
        name: skill.name,
        description: skill.description,
        category: skill.category,
        triggerWords: skill.triggerWords,
        prompt: skill.prompt,
        status: 'published',
        visibility: 'company',
        isBuiltin: true,
        authorId: admin.id,
      });
      skillIdByName.set(skill.name, id);
    }
  }
  console.log(`  技能 ${SKILLS.length} 个就绪`);

  /* ── 智能体 upsert ── */
  for (const agent of AGENTS) {
    const skillIds = agent.skillNames.map((name) => skillIdByName.get(name)).filter((id): id is string => !!id);

    const payload = {
      name: agent.name,
      description: agent.description,
      example: agent.example,
      systemPrompt: agent.systemPrompt,
      scopeKbIds: [],
      triggerWords: agent.triggerWords,
      skillIds,
      icon: agent.icon,
      publishStatus: 'published' as const,
      visibility: 'company' as const,
      isBuiltin: true,
      testedAt: new Date(),
      updatedAt: new Date(),
    };

    const existing = (await db.select().from(schema.agents).where(eq(schema.agents.builtinKey, agent.builtinKey)).limit(1))[0];

    if (existing) {
      await db.update(schema.agents).set(payload).where(eq(schema.agents.id, existing.id));
    } else {
      await db.insert(schema.agents).values({
        id: randomUUID(),
        ...payload,
        builtinKey: agent.builtinKey,
        ownerId: admin.id,
        departmentId,
      });
    }
  }
  console.log(`  智能体 ${AGENTS.length} 个就绪（周报助手 / 邮件助手 / 报账流程）`);

  await pool.end();
  console.log('完成。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
