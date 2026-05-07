import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { DesignsService } from './designs.service';
import { UploadDesignDto } from './dto/upload-design.dto';
import { QueryDesignsDto } from './dto/query-designs.dto';
import { ExtractLayerDto } from './dto/extract-layer.dto';

@ApiTags('designs')
@Controller('designs')
export class DesignsController {
  constructor(private readonly designsService: DesignsService) {}

  private requireStoreId(req: any): string {
    const id = req.store?.id as string | undefined;
    if (!id) {
      throw new ForbiddenException('Store authentication required');
    }
    return id;
  }

  @Post(':storeId')
  @ApiOperation({ summary: 'Upload a new design' })
  @ApiParam({ name: 'storeId', description: 'Ignored — derived from auth context' })
  @ApiResponse({ status: 201, description: 'Design uploaded successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  async uploadDesign(
    @Body() dto: UploadDesignDto,
    @Req() req: any,
  ) {
    const callerStoreId = this.requireStoreId(req);
    const buffer = Buffer.from(dto.fileBase64, 'base64');

    return this.designsService.uploadDesign(
      callerStoreId,
      {
        buffer,
        originalname: dto.filename,
        mimetype: dto.mimetype,
        size: buffer.length,
      },
      { name: dto.name, width: dto.width, height: dto.height },
    );
  }

  @Get(':storeId')
  @ApiOperation({ summary: 'Get all designs for a store' })
  @ApiParam({ name: 'storeId', description: 'Ignored — derived from auth context' })
  @ApiResponse({ status: 200, description: 'List of designs with pagination' })
  async getDesigns(
    @Query() query: QueryDesignsDto,
    @Req() req: any,
  ) {
    return this.designsService.getDesigns(this.requireStoreId(req), {
      page: query.page,
      limit: query.limit,
    });
  }

  @Get('detail/:designId')
  @ApiOperation({ summary: 'Get a single design' })
  @ApiParam({ name: 'designId', description: 'Design ID' })
  @ApiResponse({ status: 200, description: 'Design details' })
  @ApiResponse({ status: 404, description: 'Design not found' })
  async getDesign(@Param('designId') designId: string, @Req() req: any) {
    const callerStoreId = this.requireStoreId(req);
    const design = await this.designsService.getDesign(designId);
    if (design.storeId !== callerStoreId) throw new ForbiddenException();
    return design;
  }

  @Post('detail/:designId/extract-layer')
  @ApiOperation({ summary: 'Extract one Photoshop-style layer from a design at the click point' })
  @ApiParam({ name: 'designId', description: 'Design ID' })
  @ApiResponse({ status: 200, description: 'Layer + punched-source URLs and bbox' })
  @ApiResponse({ status: 400, description: 'No object detected at this point' })
  async extractLayer(
    @Param('designId') designId: string,
    @Body() dto: ExtractLayerDto,
    @Req() req: any,
  ) {
    return this.designsService.extractLayer(designId, this.requireStoreId(req), dto);
  }

  @Delete(':designId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a design' })
  @ApiParam({ name: 'designId', description: 'Design ID' })
  @ApiResponse({ status: 200, description: 'Design deleted successfully' })
  @ApiResponse({ status: 404, description: 'Design not found' })
  async deleteDesign(@Param('designId') designId: string, @Req() req: any) {
    const callerStoreId = this.requireStoreId(req);
    const design = await this.designsService.getDesign(designId);
    if (design.storeId !== callerStoreId) throw new ForbiddenException();
    return this.designsService.deleteDesign(designId);
  }
}
