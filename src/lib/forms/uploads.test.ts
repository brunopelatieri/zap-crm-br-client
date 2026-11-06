import { describe, expect, it } from 'vitest';

import { ACCOUNT_ID, FORM_ID, RESPONSE_ID } from './test-fixtures';
import {
  buildFormMediaPath,
  buildUploadPath,
  FORM_UPLOAD_MAX_BYTES,
  normalizeAccept,
  parseUploadPath,
  uploadPathBelongsTo,
  validateUploadRequest,
  verifyUploadedObject,
  type StorageLister,
} from './uploads';

const OBJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('validateUploadRequest (SPEC 085 §5.4)', () => {
  it('PDF dentro do limite passa com o tipo e a extensão normalizados', () => {
    expect(
      validateUploadRequest({
        name: 'Proposta.PDF',
        mime: 'application/pdf; charset=binary',
        size: 1024,
      })
    ).toEqual({
      ok: true,
      mime: 'application/pdf',
      ext: 'pdf',
      kind: 'document',
      size: 1024,
      maxBytes: FORM_UPLOAD_MAX_BYTES,
    });
  });

  it('tipo fora da allowlist, extensão que não bate e nome com barra são recusados', () => {
    expect(
      validateUploadRequest({
        name: 'x.exe',
        mime: 'application/x-msdownload',
        size: 1,
      })
    ).toEqual({ ok: false, reason: 'file_type_not_allowed' });
    expect(
      validateUploadRequest({ name: 'x.exe', mime: 'application/pdf', size: 1 })
    ).toEqual({ ok: false, reason: 'extension_mismatch' });
    expect(
      validateUploadRequest({
        name: '../x.pdf',
        mime: 'application/pdf',
        size: 1,
      })
    ).toEqual({ ok: false, reason: 'invalid_name' });
  });

  it('imagem tem teto de 5 MiB; documento vai até 16 MiB; zero bytes é inválido', () => {
    const fiveMb = 5 * 1024 * 1024;
    expect(
      validateUploadRequest({
        name: 'a.png',
        mime: 'image/png',
        size: fiveMb + 1,
      })
    ).toMatchObject({ ok: false, reason: 'file_too_large', maxBytes: fiveMb });
    expect(
      validateUploadRequest({
        name: 'a.pdf',
        mime: 'application/pdf',
        size: fiveMb + 1,
      }).ok
    ).toBe(true);
    expect(
      validateUploadRequest({ name: 'a.pdf', mime: 'application/pdf', size: 0 })
    ).toMatchObject({ ok: false, reason: 'file_too_large' });
  });

  it('o accept do bloco restringe ainda mais a allowlist', () => {
    const field = { accept: ['image/png'] };
    expect(
      validateUploadRequest(
        { name: 'a.pdf', mime: 'application/pdf', size: 1 },
        field
      )
    ).toEqual({ ok: false, reason: 'accept_not_allowed' });
    expect(
      validateUploadRequest(
        { name: 'a.png', mime: 'image/png', size: 1 },
        field
      ).ok
    ).toBe(true);
    expect(normalizeAccept(['image/png', 'IMAGE/PNG', 'text/html'])).toEqual([
      'image/png',
    ]);
  });
});

describe('caminhos no bucket', () => {
  it('monta account-<uuid>/<form>/<response>/<objeto>.<ext> e lê de volta', () => {
    const path = buildUploadPath({
      accountId: ACCOUNT_ID,
      formId: FORM_ID,
      responseId: RESPONSE_ID,
      ext: 'pdf',
      objectId: OBJECT_ID,
    });
    expect(path).toBe(
      `account-${ACCOUNT_ID}/${FORM_ID}/${RESPONSE_ID}/${OBJECT_ID}.pdf`
    );
    expect(parseUploadPath(path)).toEqual({
      accountId: ACCOUNT_ID,
      formId: FORM_ID,
      responseId: RESPONSE_ID,
      objectId: OBJECT_ID,
      ext: 'pdf',
    });
    expect(
      uploadPathBelongsTo(path, {
        accountId: ACCOUNT_ID,
        formId: FORM_ID,
        responseId: RESPONSE_ID,
      })
    ).toBe(true);
    expect(
      uploadPathBelongsTo(path, {
        accountId: ACCOUNT_ID,
        formId: FORM_ID,
        responseId: OBJECT_ID,
      })
    ).toBe(false);
    expect(parseUploadPath('account-x/../etc/passwd')).toBeNull();
  });

  it('mídia do formulário fica em account-<uuid>/<form>/ sem resposta', () => {
    expect(
      buildFormMediaPath({
        accountId: ACCOUNT_ID,
        formId: FORM_ID,
        ext: 'png',
        objectId: OBJECT_ID,
      })
    ).toBe(`account-${ACCOUNT_ID}/${FORM_ID}/${OBJECT_ID}.png`);
  });
});

describe('verifyUploadedObject (SPEC 085 §4.2 item 6)', () => {
  function storageWith(
    objects: { name: string; size?: number }[] | null,
    error = false
  ) {
    const calls: unknown[] = [];
    const storage: StorageLister = {
      from: () => ({
        list: (prefix, opts) => {
          calls.push([prefix, opts]);
          return Promise.resolve(
            error
              ? { data: null, error: { message: 'x' } }
              : {
                  data:
                    objects?.map((o) => ({
                      name: o.name,
                      metadata: { size: o.size },
                    })) ?? null,
                  error: null,
                }
          );
        },
      }),
    };
    return { storage, calls };
  }

  const path = `account-${ACCOUNT_ID}/${FORM_ID}/${RESPONSE_ID}/${OBJECT_ID}.pdf`;

  it('confere existência e tamanho declarado; lista só a pasta da resposta', async () => {
    const { storage, calls } = storageWith([
      { name: `${OBJECT_ID}.pdf`, size: 10 },
    ]);
    await expect(verifyUploadedObject(storage, path, 10)).resolves.toEqual({
      ok: true,
      size: 10,
    });
    expect(calls[0]).toEqual([
      `account-${ACCOUNT_ID}/${FORM_ID}/${RESPONSE_ID}`,
      { limit: 100, search: `${OBJECT_ID}.pdf` },
    ]);
  });

  it('ausente, tamanho diferente e erro de storage são distinguidos', async () => {
    await expect(
      verifyUploadedObject(storageWith([]).storage, path, 10)
    ).resolves.toEqual({ ok: false, reason: 'not_found' });
    await expect(
      verifyUploadedObject(
        storageWith([{ name: `${OBJECT_ID}.pdf`, size: 11 }]).storage,
        path,
        10
      )
    ).resolves.toEqual({ ok: false, reason: 'size_mismatch' });
    await expect(
      verifyUploadedObject(storageWith(null, true).storage, path, 10)
    ).resolves.toEqual({ ok: false, reason: 'storage_error' });
  });
});
