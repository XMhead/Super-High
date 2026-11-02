import { describe, expect, it } from 'vitest'

import { buildServerLogGbkHelperCommand } from './serverLog'

describe('serverLog helpers', () => {
  it('builds a GBK latest.log tail helper for local PowerShell', () => {
    const command = buildServerLogGbkHelperCommand(50)
    expect(command).toContain('function Get-ServerLog')
    expect(command).toContain("logs\\latest.log")
    expect(command).toContain('GetEncoding(936)')
    expect(command).toContain('Get-ServerLog -Tail 50')
    expect(command).toContain('server.properties')
    expect(command).toContain("spigot-1.12.2.jar")
    expect(command).not.toContain('-Encoding UTF8')
    expect(command).not.toContain('\n')
  })

  it('clamps extreme tail values', () => {
    expect(buildServerLogGbkHelperCommand(0)).toContain('Get-ServerLog -Tail 1')
    expect(buildServerLogGbkHelperCommand(99999)).toContain('Get-ServerLog -Tail 2000')
  })
})
