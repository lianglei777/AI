/**
 * skill-interceptor — 默认配置
 *
 * 配置直接在此维护，不走 openclaw.json 或 qclaw-plugin-config.json。
 * 新增/移除 skill 拦截规则时修改此文件即可。
 */

import type { SkillInterceptorConfig } from './types.js'

/**
 * skill-interceptor 默认配置
 *
 * 包含需要拦截的 skill 列表、各 skill 的授权检查模式映射。
 * 新增/移除 skill 拦截规则时修改此处即可。
 */
export const DEFAULT_CONFIG: SkillInterceptorConfig = {
  blockedSkills: [
    'tencent-docs',
    'tencent-survey',
    'notion',
    'imap-smtp-email',
    'public-skill',
    'tencent-meeting',
    'tencent-meeting-mcp',
    'ima',
    'kdocs',
    'youdaonote',
    'weiyun',
    'tencent-news',
    'wecomcli-contact',
    'wecomcli-doc',
    'wecomcli-meeting',
    'wecomcli-msg',
    'wecomcli-schedule',
    'wecomcli-todo',
    'wecomcli-setup',
    'flyai',
    'wendao-partner-qclaw-skill',
    'bdpan-storage',
  ],
  credentialHostedSkills: {
    'tencent-docs': 'tencent_docs',
    'tencent-survey': 'tencent_survey',
    'kdocs': 'kdocs',
    'notion': 'notion',
    'imap-smtp-email': '__multi_bind__',
    'public-skill': '__public_mail_4227__',
    'tencent-meeting': 'tencent_meeting',
    'tencent-meeting-mcp': 'tencent_meeting',
    'ima': 'ima',
    'youdaonote': 'youdaonote',
    'weiyun': 'tencent_weiyun',
    'tencent-news': 'tencent_news',
    'flyai': 'flyai',
    'wendao-partner-qclaw-skill': 'wendao',
    'bdpan-storage': 'bdpan',
  },
  wecomCliSkills: [
    'wecomcli-contact',
    'wecomcli-doc',
    'wecomcli-meeting',
    'wecomcli-msg',
    'wecomcli-schedule',
    'wecomcli-todo',
    'wecomcli-setup',
  ],
  manualCodeSkills: [
    'imap-smtp-email',
    'tencent-meeting',
    'tencent-meeting-mcp',
    'ima',
    'youdaonote',
    'tencent-news',
    'wecomcli-contact',
    'wecomcli-doc',
    'wecomcli-meeting',
    'wecomcli-msg',
    'wecomcli-schedule',
    'wecomcli-todo',
    'wecomcli-setup',
    'flyai',
    'wendao-partner-qclaw-skill',
    'bdpan-storage',
  ],
  logOnly: false,
}
