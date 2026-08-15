import {
  parseDatasetFiltersFlag,
  parseDatasetSortsFlag,
} from '../../src/lib/dataset-query';

describe('dataset query flag contracts', () => {
  it('accepts typed filters and sorts from the canonical runtime', () => {
    expect(parseDatasetFiltersFlag('[{"field":"status","operator":"=","value":"open"}]'))
      .toEqual([{field: 'status', operator: '=', value: 'open'}]);
    expect(parseDatasetSortsFlag('[{"field":"updatedAt","direction":"desc"}]'))
      .toEqual([{field: 'updatedAt', direction: 'desc'}]);
  });

  it('reports accepted operators and directions', () => {
    expect(() => parseDatasetFiltersFlag('[{"field":"status","operator":"like","value":"open"}]'))
      .toThrow('Accepted operators: =, !=, >, >=, <, <=, contains, in, is_null, not_null');
    expect(() => parseDatasetSortsFlag('[{"field":"updatedAt","direction":"sideways"}]'))
      .toThrow('Accepted directions: asc, desc');
  });
});
