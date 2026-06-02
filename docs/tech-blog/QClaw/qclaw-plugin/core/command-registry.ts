/**
 * core/command-registry.ts — 命令注册器
 *
 * 将 package 注册的聊天命令统一代理到 OpenClaw 的 api.registerCommand。
 */

import type { CommandConfig, OpenClawPluginApi } from './types.js'

const LOG_TAG = '[qclaw-plugin:command-registry]'

export interface RegisteredCommand {
  packageId: string
  command: CommandConfig
}

export class CommandRegistry {
  private api: OpenClawPluginApi
  private commands: RegisteredCommand[] = []

  constructor(api: OpenClawPluginApi) {
    this.api = api
  }

  /**
   * 注册一个聊天命令
   * @param packageId 来源 package 的 ID
   * @param command 命令配置
   */
  register(packageId: string, command: CommandConfig): void {
    this.commands.push({ packageId, command })

    if (this.api.registerCommand) {
      this.api.registerCommand(command)
      console.log(`${LOG_TAG} registered command: /${command.name} (from ${packageId})`)
    } else {
      console.warn(`${LOG_TAG} api.registerCommand not available, skipping: /${command.name}`)
    }
  }

  /**
   * 获取所有已注册的命令（用于调试/测试）
   */
  getCommands(): readonly RegisteredCommand[] {
    return this.commands
  }
}
