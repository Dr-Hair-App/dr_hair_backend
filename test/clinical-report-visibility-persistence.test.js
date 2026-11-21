import assert from 'node:assert/strict';
import test from 'node:test';
import { ClinicalReportRepository } from '../src/modules/admin/infrastructure/ClinicalReportRepository.js';
import { clearDatabaseBinding, setWorkerBindings } from '../src/shared/database/runtime.js';
import { ClinicalReportModel } from '../src/shared/database/models.js';

test('sharing an existing report uses a database condition that requires a clean scan', async () => {
  let updateFilter;
  setWorkerBindings({ DB: { prepare() { throw new Error('No database query expected in this repository test.'); } } });
  try {
    const repository = new ClinicalReportRepository();
    repository.findByUserIdAndId = async () => ({
      userId: 42,
      id: 'rpt_1',
      visibility: 'Private',
      scanning_status: 'clean',
    });
    const originalFindOneAndUpdate = ClinicalReportModel.findOneAndUpdate;
    ClinicalReportModel.findOneAndUpdate = (filter) => {
      updateFilter = filter;
      return { lean: async () => null };
    };
    try {
      await repository.updateVisibilityWithResult(42, 'rpt_1', 'Shared', 'admin@example.test', true);
    } finally {
      ClinicalReportModel.findOneAndUpdate = originalFindOneAndUpdate;
    }

    assert.equal(updateFilter.scanning_status, 'clean');
    assert.equal(updateFilter.userId, 42);
    assert.equal(updateFilter.id, 'rpt_1');
  } finally {
    clearDatabaseBinding();
  }
});
