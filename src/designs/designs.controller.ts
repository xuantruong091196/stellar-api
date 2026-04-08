import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { DesignsService } from './designs.service';

@ApiTags('designs')
@Controller('designs')
export class DesignsController {
  constructor(private readonly designsService: DesignsService) {}

  @Post(':storeId')
  @ApiOperation({ summary: 'Upload a new design' })
  async uploadDesign(
    @Param('storeId') storeId: string,
    @Body()
    body: {
      name: string;
      fileBase64: string;
      filename: string;
      mimetype: string;
      width?: number;
      height?: number;
    },
  ) {
    // Convert base64 to buffer (file upload middleware can replace this)
    const buffer = Buffer.from(body.fileBase64, 'base64');

    return this.designsService.uploadDesign(
      storeId,
      {
        buffer,
        originalname: body.filename,
        mimetype: body.mimetype,
        size: buffer.length,
      },
      { name: body.name, width: body.width, height: body.height },
    );
  }

  @Get(':storeId')
  @ApiOperation({ summary: 'Get all designs for a store' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getDesigns(
    @Param('storeId') storeId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.designsService.getDesigns(storeId, { page, limit });
  }

  @Get('detail/:designId')
  @ApiOperation({ summary: 'Get a single design' })
  async getDesign(@Param('designId') designId: string) {
    return this.designsService.getDesign(designId);
  }

  @Delete(':designId')
  @ApiOperation({ summary: 'Delete a design' })
  async deleteDesign(@Param('designId') designId: string) {
    return this.designsService.deleteDesign(designId);
  }
}
