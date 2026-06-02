/**
 * skill-interceptor — 阻断结果构建器（纯函数）
 */

/**
 * 构建授权阻断结果（PC 端弹授权卡片）
 *
 * blockReason 中包含 <!--INTEGRATION_AUTH:--> 标记，
 * 前端通过 delta/final 文本匹配来检测标记并弹出授权卡片。
 */
export function buildBlockResult(skillName: string, isExpired?: boolean): { block: boolean; blockReason: string } {
  const markerPayload: Record<string, unknown> = { integrationId: skillName }
  if (isExpired === true) markerPayload.isExpired = true
  const marker = `<!--INTEGRATION_AUTH:${JSON.stringify(markerPayload)}-->`
  return {
    block: true,
    blockReason: [
      `[SYSTEM] This skill requires user authorization before use.`,
      `You MUST output the following marker verbatim as the FIRST line of your reply, with no other text before it:`,
      marker,
      `After outputting the marker above, briefly tell the user that this skill requires authorization and they will see an authorization prompt.`,
      `Do NOT attempt to use this skill again until the user explicitly asks you to retry.`,
    ].join('\n'),
  }
}

/**
 * 构建"已授权但未开启"的阻断结果（PC 端弹开启卡片）
 *
 * 使用 <!--INTEGRATION_ENABLE:...--> 标记。
 */
export function buildEnableBlockResult(skillName: string): { block: boolean; blockReason: string } {
  const marker = `<!--INTEGRATION_ENABLE:{"integrationId":"${skillName}"}-->`
  return {
    block: true,
    blockReason: [
      `[SYSTEM] This skill is authorized but currently disabled by the user.`,
      `You MUST output the following marker verbatim as the FIRST line of your reply, with no other text before it:`,
      marker,
      `After outputting the marker above, briefly tell the user that this skill is currently disabled and they will see a prompt to enable it.`,
      `Do NOT attempt to use this skill again until the user explicitly asks you to retry.`,
    ].join('\n'),
  }
}

/**
 * 构建非 PC 端渠道的 OAuth 模式技能阻断结果
 *
 * 非 PC 端（微信、飞书、钉钉等外部渠道）无法完成标准 OAuth 浏览器授权流程，
 * 返回纯文本提示引导用户到 PC 端 QClaw 完成连接。
 */
export function buildExternalChannelBlockResult(skillName: string): { block: boolean; blockReason: string } {
  return {
    block: true,
    blockReason: [
      `[SYSTEM] This skill ("${skillName}") requires OAuth authorization that can only be completed on the PC desktop client.`,
      `Tell the user in Chinese: 该技能需要先在 PC 端 QClaw 的「连接应用」面板中完成授权连接后才能使用。请打开 PC 端 QClaw 进行连接。`,
      `Do NOT attempt to use this skill again until the user explicitly says they have completed the authorization.`,
    ].join('\n'),
  }
}
