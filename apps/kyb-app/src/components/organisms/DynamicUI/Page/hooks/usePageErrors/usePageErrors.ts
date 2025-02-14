import { useMemo } from 'react';
import { Document, UIElement, UIPage } from '@app/domains/collection-flow';
import { ErrorField } from '@app/components/organisms/DynamicUI/rule-engines';
import { AnyObject } from '@ballerine/ui';
import {
  findDefinitionByDestinationPath,
  findDefinitionByName,
} from '@app/components/organisms/UIRenderer/elements/JSONForm/helpers/findDefinitionByName';

export interface PageError {
  page: number;
  pageName: string;
  stateName: string;
  errors: ErrorField[];
  _elements: UIElement<AnyObject>[];
}

export const usePageErrors = (context: AnyObject, pages: UIPage[]): PageError[] => {
  const pageErrors = useMemo(() => {
    const pagesWithErrors: PageError[] = pages.map(page => {
      const pageErrorBase: PageError = {
        page: page.number,
        pageName: page.name,
        stateName: page.stateName,
        errors: [],
        _elements: page.elements,
      };

      return pageErrorBase;
    });

    pagesWithErrors.forEach(pageError => {
      pageError.errors = (context.documents as Document[])
        .filter((document, index) => {
          if (
            !(document?.decision?.status == 'revision' || document?.decision?.status == 'rejected')
          ) {
            return false;
          }

          const documentPath = `documents[${index}].pages[0].ballerineFileId`;

          return Boolean(findDefinitionByDestinationPath(documentPath, pageError._elements));
        })
        .map(document => {
          const documentPath = `document-error-${document.id}`;
          const message = document?.decision?.revisionReason;

          return {
            fieldId: documentPath,
            fieldDestination: documentPath,
            message,
            type: 'warning',
          };
        });
    });

    return pagesWithErrors;
  }, [pages, context]);

  return pageErrors;
};
