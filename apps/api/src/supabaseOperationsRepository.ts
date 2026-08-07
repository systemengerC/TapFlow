import {
  ApplyOperationsResponseSchema,
  type ApplyOperationsRequest,
  type ApplyOperationsResponse,
} from '@tapflow/contracts';

import {
  UnauthorizedError,
  VersionConflictError,
  type OperationsRepository,
} from './app.ts';

type Options = {
  supabaseUrl: string;
  anonKey: string;
  fetcher?: typeof fetch;
};

type SupabaseError = {
  code?: string;
  message?: string;
};

export class SupabaseOperationsRepository implements OperationsRepository {
  private readonly baseUrl: string;
  private readonly anonKey: string;
  private readonly fetcher: typeof fetch;

  constructor({ supabaseUrl, anonKey, fetcher = fetch }: Options) {
    this.baseUrl = supabaseUrl.replace(/\/$/, '');
    this.anonKey = anonKey;
    this.fetcher = fetcher;
  }

  async apply(
    projectId: string,
    request: ApplyOperationsRequest,
    authorization?: string,
  ): Promise<ApplyOperationsResponse> {
    if (!authorization) {
      throw new UnauthorizedError('Authorization is required for Supabase operations');
    }

    const response = await this.fetcher(
      `${this.baseUrl}/rest/v1/rpc/apply_project_operations`,
      {
        method: 'POST',
        headers: this.headers(authorization),
        body: JSON.stringify({
          p_project_id: projectId,
          p_base_version: request.baseVersion,
          p_actor: 'user',
          p_group_id: request.operationGroupId ?? null,
          p_operations: request.operations,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as SupabaseError;
      if (error.code === '23505') {
        throw new VersionConflictError(await this.getCurrentVersion(projectId, authorization));
      }
      throw new Error(error.message ?? `Supabase RPC failed with HTTP ${response.status}`);
    }

    return ApplyOperationsResponseSchema.parse({
      appliedOperationIds: request.operations.map(({ operationId }) => operationId),
      canvasVersion: await response.json(),
    });
  }

  private async getCurrentVersion(projectId: string, authorization: string): Promise<number> {
    const response = await this.fetcher(
      `${this.baseUrl}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&select=canvas_version`,
      { headers: this.headers(authorization) },
    );
    if (!response.ok) {
      throw new Error(`Failed to read current canvas version: HTTP ${response.status}`);
    }
    const rows = await response.json() as Array<{ canvas_version: number }>;
    if (rows.length !== 1 || !Number.isInteger(rows[0].canvas_version)) {
      throw new Error('Project canvas version was not found');
    }
    return rows[0].canvas_version;
  }

  private headers(authorization: string): HeadersInit {
    return {
      apikey: this.anonKey,
      authorization,
      'content-type': 'application/json',
    };
  }
}