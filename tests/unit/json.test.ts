import { describe, expect, it } from 'vitest'
import { createDefaultProject } from '../../src/domain/defaultProject'
import {
  parseProjectJson,
  ProjectValidationError,
  serializeProject,
  sha256Text,
} from '../../src/io/json/projectJson'

describe('project JSON', () => {
  it('round-trips the default project', () => {
    const project = createDefaultProject()
    expect(parseProjectJson(serializeProject(project))).toEqual(project)
  })

  it('結果バンドルを再読込する際は保存結果を信頼せず入力案件だけを復元する', () => {
    const project = createDefaultProject()
    expect(parseProjectJson(JSON.stringify({ project, result: { untrusted: true } }))).toEqual(
      project,
    )
  })

  it('rejects a discontinuous layer model', () => {
    const project = createDefaultProject()
    project.ground.layers[1]!.topDepthM = 2
    expect(() => serializeProject(project)).toThrow(ProjectValidationError)
  })

  it('computes the known SHA-256 digest', async () => {
    expect(await sha256Text('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})
