import { describe, it, expect } from 'vitest'
import { DrafterElementType } from './drafter.js'
import type { DrafterNote, DrafterDiameterDimension, DrafterData } from './drafter.js'

describe('Drafter', () => {
  describe('DrafterElementType', () => {
    it('should have correct type values', () => {
      expect(DrafterElementType.NOTE).toBe('note')
      expect(DrafterElementType.DIMENSION_DIAMETER).toBe('dimension-diameter')
    })
  })

  describe('DrafterData', () => {
    it('should handle valid data structure', () => {
      const mockData = {
        elements: [
          {
            type: DrafterElementType.NOTE,
            position: { x: 1, y: 2 },
            contents: 'Test Note'
          } as DrafterNote,
          {
            type: DrafterElementType.DIMENSION_DIAMETER,
            deterministicId: 'test-id'
          } as DrafterDiameterDimension
        ]
      } satisfies DrafterData

      expect(mockData.elements).toHaveLength(2)
      expect(mockData.elements[0].type).toBe(DrafterElementType.NOTE)
      expect(mockData.elements[1].type).toBe(DrafterElementType.DIMENSION_DIAMETER)
    })
  })
})