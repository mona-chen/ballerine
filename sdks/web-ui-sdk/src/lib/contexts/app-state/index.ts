export {
  appState,
  documents,
  selfieUri,
  selectedDocumentInfo,
  currentStepIdx,
  currentStepId,
  currentParams,
  bvnValue,
  livenessResult,
} from './stores';
export type {
  IAppState,
  IDocument,
  IDocumentInfo,
  IDocumentPage,
  DevMocks,
  IStoreData,
  ISelectedParams,
} from './types';
export { DocumentType, DocumentKind } from './types';
export { getDocImage } from './utils';
