import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
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

@ApiTags('designs')
@Controller('designs')
export class DesignsController {
  constructor(private readonly designsService: DesignsService) {}

  @Post(':storeId')
  @ApiOperation({ summary: 'Upload a new design' })
  @ApiParam({ name: 'storeId', description: 'Store ID' })
  @ApiResponse({ status: 201, description: 'Design uploaded successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  async uploadDesign(
    @Param('storeId') storeId: string,
    @Body() dto: UploadDesignDto,
  ) {
    // Convert base64 to buffer
    const buffer = Buffer.from(dto.fileBase64, 'base64');

    return this.designsService.uploadDesign(
      storeId,
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
  @ApiParam({ name: 'storeId', description: 'Store ID' })
  @ApiResponse({ status: 200, description: 'List of designs with pagination' })
  async getDesigns(
    @Param('storeId') storeId: string,
    @Query() query: QueryDesignsDto,
  ) {
    return this.designsService.getDesigns(storeId, {
      page: query.page,
      limit: query.limit,
    });
  }

  @Get('detail/:designId')
  @ApiOperation({ summary: 'Get a single design' })
  @ApiParam({ name: 'designId', description: 'Design ID' })
  @ApiResponse({ status: 200, description: 'Design details' })
  @ApiResponse({ status: 404, description: 'Design not found' })
  async getDesign(@Param('designId') designId: string) {
    return this.designsService.getDesign(designId);
  }

  @Delete(':designId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a design' })
  @ApiParam({ name: 'designId', description: 'Design ID' })
  @ApiResponse({ status: 200, description: 'Design deleted successfully' })
  @ApiResponse({ status: 404, description: 'Design not found' })
  async deleteDesign(@Param('designId') designId: string) {
    return this.designsService.deleteDesign(designId);
  }
}
