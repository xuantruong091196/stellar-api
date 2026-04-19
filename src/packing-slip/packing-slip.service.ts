import { Injectable, Logger } from '@nestjs/common';
import * as QRCode from 'qrcode';
import * as PDFDocument from 'pdfkit';
import { S3Service } from '../common/services/s3.service';

@Injectable()
export class PackingSlipService {
  private readonly logger = new Logger(PackingSlipService.name);

  constructor(private readonly s3: S3Service) {}

  async generate(
    orderId: string,
    nfts: Array<{
      id: string;
      assetCode: string;
      serialNumber: number;
      productTitle: string;
      designerName: string;
    }>,
  ): Promise<string> {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    for (let i = 0; i < nfts.length; i++) {
      const nft = nfts[i];
      if (i > 0) doc.addPage();

      doc.fontSize(20).font('Helvetica-Bold').text('STELO', { align: 'center' });
      doc.fontSize(12).font('Helvetica').text('Certificate of Authenticity', { align: 'center' });
      doc.moveDown(2);

      const qrUrl = `https://stelo.life/verify/${nft.id}`;
      const qrBuffer = await QRCode.toBuffer(qrUrl, {
        width: 200,
        errorCorrectionLevel: 'H',
      });
      doc.image(qrBuffer, (doc.page.width - 200) / 2, doc.y, { width: 200 });
      doc.moveDown(8);

      doc.fontSize(14).font('Helvetica-Bold').text(nft.productTitle, { align: 'center' });
      doc.fontSize(11).font('Helvetica').text(`Serial #${nft.serialNumber}`, { align: 'center' });
      doc.text(`by ${nft.designerName}`, { align: 'center' });
      doc.moveDown(2);

      doc.fontSize(9).fillColor('#666666')
        .text('Scan the QR code to verify authenticity', { align: 'center' })
        .text(qrUrl, { align: 'center' })
        .moveDown(1)
        .text('Powered by Stellar Blockchain', { align: 'center' });
    }

    doc.end();
    const buffer = await new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });

    const key = `packing-slips/${orderId}.pdf`;
    const url = await this.s3.uploadFile(key, buffer, 'application/pdf');
    this.logger.log(`Packing slip generated: ${key} (${nfts.length} NFTs)`);
    return url;
  }
}
