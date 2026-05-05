import { ProvenanceMetadataService } from './provenance-metadata.service';

describe('ProvenanceMetadataService.build', () => {
  let svc: ProvenanceMetadataService;
  beforeEach(() => {
    svc = new ProvenanceMetadataService(null as any);
  });

  it('produces SEP-0039 compliant JSON with hash', () => {
    const result = svc.build({
      designId: 'd1',
      designName: 'Cool Tee',
      storeName: 'Acme',
      ownerWallet: 'GABC',
      fileSha256: 'sha256val',
      fileUrl: 'https://r2/x',
      thumbnailUrl: 'https://r2/x.jpg',
      thumbnailHash: 'thumbHash',
      width: 4200,
      height: 4800,
      mimeType: 'image/png',
      assetCode: 'STELOD0001',
      serial: 1,
      createdAt: new Date('2026-05-04'),
    });
    expect(result.json.name).toBe('Stelo Design #1');
    expect(result.json.attributes).toContainEqual({
      trait_type: 'File SHA-256',
      value: 'sha256val',
    });
    expect(result.json.stelo.type).toBe('design_provenance');
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('omits image_integrity when thumbnailHash is null', () => {
    const result = svc.build({
      designId: 'd1',
      designName: 'X',
      storeName: 'A',
      ownerWallet: 'GABC',
      fileSha256: 's',
      fileUrl: 'https://r2/x',
      thumbnailUrl: 'https://r2/x.jpg',
      thumbnailHash: null,
      width: null,
      height: null,
      mimeType: 'image/png',
      assetCode: 'STELOD0001',
      serial: 1,
      createdAt: new Date(),
    });
    expect(result.json.image_integrity).toBeUndefined();
  });
});
