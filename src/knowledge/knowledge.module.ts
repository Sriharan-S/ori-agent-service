import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { DocumentService } from './document.service';
import { EmbeddingService } from './embedding.service';
import { ExtractorService } from './extractor.service';
import { RetrievalService } from './retrieval.service';

/**
 * The knowledge base.
 *
 * Depends on the LLM module only for the embedding half, and works without it:
 * a deployment with no `embedding` model configured still ingests documents and
 * still searches them lexically.
 */
@Module({
  imports: [LlmModule],
  providers: [
    ExtractorService,
    EmbeddingService,
    DocumentService,
    RetrievalService,
  ],
  exports: [DocumentService, RetrievalService, EmbeddingService],
})
export class KnowledgeModule {}
