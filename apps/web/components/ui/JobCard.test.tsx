/**
 * JobCard 组件级渲染测试（真实 React 渲染，无 mock 框架）。
 *
 * 覆盖 gpt 门禁指出的缺口：重试按钮的存在条件、在途禁用（防连点）、提交失败可见。
 * 用 react-dom/server 渲染真实组件并断言输出 HTML —— 不引入 jsdom/RTL 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { JobCard } from './JobsPanel.tsx';
import { createRetryController } from '../../lib/jobs/retryController.ts';
import type { Job, JobStatus, Uuid } from '@tapflow/contracts';

const JOB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as Uuid;
const NODE_A = '11111111-1111-4111-8111-111111111111' as Uuid;

function job(status: JobStatus, overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_A,
    projectId: '99999999-9999-4999-8999-999999999999' as Uuid,
    parentJobId: null,
    attempt: 1,
    jobType: 'text_to_image',
    provider: 'openai',
    model: 'dall-e-3',
    params: { prompt: '一只猫' },
    inputNodeIds: [NODE_A],
    status,
    providerJobId: null,
    errorCode: status === 'failed' ? 'PROVIDER_TIMEOUT' : null,
    errorMessage: status === 'failed' ? 'provider timeout' : null,
    idempotencyKey: '88888888-8888-4888-8888-888888888888' as Uuid,
    cancelRequestedAt: null,
    finishedAt: null,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  } as Job;
}

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

describe('JobCard 重试按钮渲染条件', () => {
  test('failed 状态渲染重试按钮', () => {
    const html = render(<JobCard job={job('failed')} onCancel={() => {}} onRetry={() => {}} />);
    assert.ok(html.includes('重试'), '失败任务必须有重试入口');
    assert.ok(html.includes('provider timeout'), '应展示失败原因');
  });

  test('succeeded / running / queued 不渲染重试按钮', () => {
    for (const status of ['succeeded', 'running', 'queued'] as JobStatus[]) {
      const html = render(<JobCard job={job(status)} onCancel={() => {}} onRetry={() => {}} />);
      assert.ok(!html.includes('重试'), `${status} 不应出现重试按钮`);
    }
  });

  test('未传 onRetry 时不渲染重试按钮', () => {
    const html = render(<JobCard job={job('failed')} onCancel={() => {}} />);
    assert.ok(!html.includes('重试'), '无回调时不应渲染无效按钮');
  });
});

describe('JobCard 防重复点击', () => {
  test('retrySubmitting=true 时按钮被禁用', () => {
    const html = render(
      <JobCard job={job('failed')} onCancel={() => {}} onRetry={() => {}} retrySubmitting />,
    );
    assert.ok(html.includes('disabled'), '在途必须禁用按钮，否则连点会创建重复 job');
    assert.ok(html.includes('提交中'), '应给出在途反馈');
  });

  test('retrySubmitting=false 时按钮可用', () => {
    const html = render(
      <JobCard job={job('failed')} onCancel={() => {}} onRetry={() => {}} retrySubmitting={false} />,
    );
    assert.ok(!html.includes('disabled'), '空闲时按钮应可点击');
    assert.ok(html.includes('🔄 重试'));
  });
});

describe('JobCard 提交失败可见', () => {
  test('retryError 渲染为 alert', () => {
    const html = render(
      <JobCard
        job={job('failed')}
        onCancel={() => {}}
        onRetry={() => {}}
        retryError="网络中断"
      />,
    );
    assert.ok(html.includes('role="alert"'), '错误应可被辅助技术识别');
    assert.ok(html.includes('网络中断'), '错误详情必须可见');
  });

  test('无 retryError 时不渲染 alert', () => {
    const html = render(<JobCard job={job('failed')} onCancel={() => {}} onRetry={() => {}} />);
    assert.ok(!html.includes('role="alert"'));
  });
});

describe('JobCard + retryController 端到端（真实点击语义）', () => {
  test('连续触发 onRetry 只提交一次，且期间渲染为禁用', async () => {
    let submitCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const controller = createRetryController(async () => {
      submitCount += 1;
      await gate;
      return JOB_A;
    });

    const failed = job('failed');
    // 模拟用户双击：直接调用组件绑定的同一回调
    const first = controller.retry(failed);
    const second = controller.retry(failed);

    // 在途快照：按钮必须是禁用态
    const htmlDuring = render(
      <JobCard
        job={failed}
        onCancel={() => {}}
        onRetry={(j) => controller.retry(j)}
        retrySubmitting={controller.isSubmitting(failed.id)}
      />,
    );
    assert.ok(htmlDuring.includes('disabled'), '在途渲染必须是禁用态');

    release();
    await Promise.all([first, second]);

    assert.equal(submitCount, 1, '双击只应提交一次');

    // 完成后快照：按钮恢复可用
    const htmlAfter = render(
      <JobCard
        job={failed}
        onCancel={() => {}}
        onRetry={(j) => controller.retry(j)}
        retrySubmitting={controller.isSubmitting(failed.id)}
      />,
    );
    assert.ok(!htmlAfter.includes('disabled'), '完成后应恢复可点击');
  });

  test('提交失败后错误渲染进卡片', async () => {
    const controller = createRetryController(async () => {
      throw new Error('500 Internal Server Error');
    });
    const failed = job('failed');

    await controller.retry(failed);

    const html = render(
      <JobCard
        job={failed}
        onCancel={() => {}}
        onRetry={(j) => controller.retry(j)}
        retrySubmitting={controller.isSubmitting(failed.id)}
        retryError={controller.errorFor(failed.id)}
      />,
    );
    assert.ok(html.includes('500 Internal Server Error'), '提交失败必须展示给用户');
    assert.ok(!html.includes('disabled'), '失败后按钮必须可再次点击');
  });
});
