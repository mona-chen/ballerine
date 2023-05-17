import {
  IStreamableFileProvider,
  TLocalFilePath,
  TRemoteFileConfig,
  TRemoteUri,
} from '@/providers/file/types';
import { promises as fsPromises } from 'fs';
import axios, { AxiosResponse } from 'axios';
import { Readable } from 'stream';

export class HttpFileService implements IStreamableFileProvider {
  protected client;
  constructor(..._args: any) {
    this.client = axios;
  }

  async downloadFile(
    remoteFileConfig: TRemoteFileConfig,
    localFilePath: TLocalFilePath,
  ): Promise<TLocalFilePath> {
    try {
      const response = await this.client.get(remoteFileConfig as TRemoteUri, {
        responseType: 'arraybuffer',
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Error downloading file: ${response.statusText}`);
      }

      const fileBuffer = response.data;
      await fsPromises.writeFile(localFilePath, Buffer.from(fileBuffer));
      return localFilePath;
    } catch (error) {
      console.error('Error downloading the file:', error);
      throw error;
    }
  }

  async isRemoteFileExists(remoteFileConfig: TRemoteUri): Promise<boolean> {
    try {
      const response = await this.client.head(remoteFileConfig);
      return response.status >= 200 && response.status < 300;
    } catch (error) {
      console.error('Error checking if remote file exists:', error);
      throw error;
    }
  }

  async uploadFile(...any: any): Promise<TRemoteFileConfig> {
    throw new Error('Unable to use upload to uri client');
  }

  async fetchRemoteFileDownStream(remoteFileConfig: TRemoteFileConfig): Promise<Readable> {
    const remoteUri = remoteFileConfig as TRemoteUri;

    const response: AxiosResponse<Readable> = await axios.get(remoteUri, {
      responseType: 'stream',
    });

    return response.data;
  }

  async uploadFileStream(
    fileStream: Readable,
    remoteFileConfig: TRemoteFileConfig,
  ): Promise<TRemoteFileConfig> {
    throw new Error('Unable to use upload to uri client');
  }
}
