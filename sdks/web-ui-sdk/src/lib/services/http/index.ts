import { ISelectedParams, IStoreData } from '../../contexts/app-state';
import { IDocumentVerificationResponse } from './types';
import {
  getAuthorizationHeader,
  getUpdateContextEndpoint,
  getUploadFileEndpoint,
  getVerificationStatusEndpoint,
  getValidateBvnEndpoint,
  getSubmitLivenessResultEndpoint,
} from '../../contexts/configuration/getters';
import { AnyRecord } from '../../../types';

const uploadFileEndpoint = getUploadFileEndpoint();
const updateContextEndpoint = getUpdateContextEndpoint();

export const generateParams = (data: IDocumentVerificationResponse): ISelectedParams => {
  const params: ISelectedParams = { sync: true };

  Object.keys(data).forEach(key => {
    params[key] = data[key as keyof IDocumentVerificationResponse] as string;
  });

  return params;
};

const staticHeaders = {
  mode: 'no-cors',
};

const httpPost = async <TResponse>(url: string, body: FormData) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: getAuthorizationHeader(),
      ...staticHeaders,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `Error fetching ${url}. http code: ${response.status}, ${response.statusText}.`,
    );
  }

  return (await response.json()) as Promise<TResponse>;
};

const httpPatch = async <TResponse>(url: string, body: AnyRecord) => {
  const init = {
    method: 'PATCH',
    headers: {
      Authorization: getAuthorizationHeader(),
      'Content-Type': 'application/json',
      ...staticHeaders,
    },
    body: JSON.stringify(body),
  };

  const response = await fetch(url, init);

  if (!response.ok) {
    throw new Error(
      `Error patching ${url}. http code: ${response.status}, ${response.statusText}.`,
    );
  }

  return (await response.json()) as Promise<TResponse>;
};

const httpGet = async (url: string) => {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: getAuthorizationHeader(),
    },
  });

  if (!response.ok) {
    throw new Error(
      `Error fetching ${url}. http code: ${response.status}, ${response.statusText}.`,
    );
  }

  return response.json();
};

export const getVerificationStatus = async (_endUserId: string) => {
  const verificationId = localStorage.getItem('verificationId') as string;
  const endpointUrl = getVerificationStatusEndpoint({ verificationId });

  // TODO: Enter a validation step here that would infer the response's type
  return httpGet(endpointUrl) as Promise<IDocumentVerificationResponse>;
};

const base64ToBlob = (dataURI: string) => {
  const splitDataURI = dataURI.split(',');
  const byteString =
    splitDataURI[0].indexOf('base64') >= 0 ? atob(splitDataURI[1]) : decodeURI(splitDataURI[1]);
  const mimeString = splitDataURI[0].split(':')[1].split(';')[0];

  const ia = new Uint8Array(byteString.length);

  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i);
  }

  return new Blob([ia], { type: mimeString });
};

const createDocument = (
  {
    metadata,
    type,
    kind,
  }: {
    metadata: Record<string, string>;
    type: string;
    kind?: string;
  },
  pages: { ballerineFileId: string; metadata: { side: string } }[],
) => ({
  metadata,
  type,
  category: kind,
  properties: {},
  issuingVersion: 1,
  version: 1,
  issuer: {
    country: 'ZZ',
  },
  pages,
});

const updateContext = async (context: Record<string, unknown>) => {
  return await httpPatch(updateContextEndpoint, { context });
};

export const verifyDocuments = async (data: IStoreData): Promise<string> => {
  if (data.selfie) {
    data.docs[0].pages.push({
      side: 'selfie',
      base64: data.selfie,
    });
  }

  const promises = data.docs.flatMap(doc =>
    doc.pages.map(async page => {
      const formData = new FormData();
      formData.append('file', base64ToBlob(page.base64 as string), `${doc.type}.jpeg`);

      const { id } = await httpPost<{ id: string }>(uploadFileEndpoint, formData);

      return { ballerineFileId: id, metadata: { side: page.side } };
    }),
  );

  const results = await Promise.all(promises);

  const documents = data.docs.map(doc => createDocument(doc, results));

  await updateContext({ documents });

  localStorage.setItem('verificationId', results[0].ballerineFileId);

  return results[0].ballerineFileId;
};

export interface BvnValidationRequest {
  bvn: string;
}

export interface BvnValidationResponse {
  isValid: boolean;
  message?: string;
  customerInfo?: {
    firstName?: string;
    lastName?: string;
    dateOfBirth?: string;
  };
}

export const validateBvn = async (bvn: string): Promise<BvnValidationResponse> => {
  // Development mock to avoid CORS issues
  if (import.meta.env.DEV) {
    console.log('MOCK BVN validation for:', bvn);
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Mock validation logic
    if (bvn.length === 11 && /^\d+$/.test(bvn)) {
      return {
        isValid: true,
        customerInfo: {
          firstName: 'John',
          lastName: 'Doe',
          dateOfBirth: '1990-01-01',
        },
      };
    } else {
      return {
        isValid: false,
        message: 'Invalid BVN number. Please enter a valid 11-digit BVN.',
      };
    }
  }

  const endpointUrl = getValidateBvnEndpoint();
  return await httpPatch<BvnValidationResponse>(endpointUrl, { bvn });
};

export interface ChallengeResult {
  challengeId: string;
  completed: boolean;
  quality: number;
  padScore: number;
  duration: number;
  snapshot: string;
}

export interface LivenessMetadata {
  userAgent: string;
  timestamp: number;
  challengeDuration: number;
  retryCount: number;
  sessionId?: string;
}

export interface LivenessResultRequest {
  sessionId: string;
  bvn: string;
  livenessScore: number;
  challenges: ChallengeResult[];
  metadata: LivenessMetadata;
  verificationId?: string;
  // Legacy support
  snapshots?: string[];
  faceLandmarks?: any[];
}

export interface LivenessResultResponse {
  success: boolean;
  verificationId: string;
  sessionId?: string;
  confidence?: number;
  riskScore?: number;
  recommendations?: string[];
  message?: string;
}

export const submitLivenessResult = async (
  data: LivenessResultRequest,
): Promise<LivenessResultResponse> => {
  // Development mock to avoid CORS issues
  if (import.meta.env.DEV) {
    console.log('MOCK liveness result submission:', data);
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Mock response
    return {
      success: true,
      verificationId: `mock_verification_${Date.now()}`,
      sessionId: data.sessionId,
      confidence: data.livenessScore > 80 ? 0.95 : 0.75,
      riskScore: data.livenessScore > 80 ? 0.05 : 0.25,
      recommendations: data.livenessScore > 80 ? [] : ['Consider improving lighting conditions'],
    };
  }

  const endpointUrl = getSubmitLivenessResultEndpoint();
  return await httpPatch<LivenessResultResponse>(endpointUrl, data);
};
