export class ProvenancePublicDto {
  designId: string;
  storeName: string;
  ownerWallet: string;
  fileSha256: string;
  assetCode: string | null;
  status: string;
  mintTxHash: string | null;
  mintLedger: number | null;
  registeredAt: Date;
  metadataUrl: string | null;
  stellarExplorerUrl: string | null;
}
