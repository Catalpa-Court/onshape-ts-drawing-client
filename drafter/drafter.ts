import { mainLog } from '../utils/logger.js';
import { ApiClient } from '../utils/apiclient.js';
import { BasicNode, DrawingObjectType, ModifyStatusResponseOutput, SingleRequestResultStatus, GetDrawingJsonExportResponse, GetViewJsonGeometryResponse, SnapPointType, View2 } from '../utils/onshapetypes.js';
import { usage, waitForModifyToFinish, DrawingScriptArgs, parseDrawingScriptArgs, validateBaseURLs, getRandomViewOnActiveSheetFromExportData, getDrawingJsonExport, convertPointViewToPaper, pointOnCircle, getAllViewsOnActiveSheetFromExportData } from '../utils/drawingutils.js';
import * as fs from 'fs';
import * as path from 'path';

// Class for drafter element types (matching Onshape's pattern)
export class DrafterElementType {
  static NOTE = 'note';
  static DIMENSION_DIAMETER = 'dimension-diameter';
}

// Type for the entire drafter data structure
export interface DrafterData {
  elements: DrafterElement[];
}

// Base interface for all drafter elements
export interface DrafterElement {
  type: string;  // Using string since we're using static class properties
}

// Interface for position coordinates
interface Position {
  x: number;
  y: number;
}

// Note element implementation
export interface DrafterNote extends DrafterElement {
  type: typeof DrafterElementType.NOTE;  // This will be 'note'
  position: Position;
  contents: string;
}

// Diameter dimension element implementation
interface ProcessedDiameterDimension {
  uniqueId: string;
  viewId: string;
  chordPoint: number[];
  farChordPoint: number[];
  textLocation: number[];
}

export interface DrafterDiameterDimension extends DrafterElement {
  type: typeof DrafterElementType.DIMENSION_DIAMETER;
  deterministicId: string;
}

// Type guard functions to check element types
function isDrafterNote(element: DrafterElement): element is DrafterNote {
  return element.type === DrafterElementType.NOTE;
}

function isDrafterDiameterDimension(element: DrafterElement): element is DrafterDiameterDimension {
  return element.type === DrafterElementType.DIMENSION_DIAMETER;
}

interface OnshapeNote {
  type: typeof DrawingObjectType.NOTE;
  note: {
    position: {
      type: 'Onshape::Reference::Point';
      coordinate: [number, number, number];
    };
    contents: string;
    textHeight: number;
  };
}

function convertDrafterNoteToOnshape(note: DrafterNote, textHeight: number): OnshapeNote {
  const x: number = parseFloat(note.position.x.toString());
  const y: number = parseFloat(note.position.y.toString());
  
  if (isNaN(x) || isNaN(y)) {
    throw new Error(`Invalid coordinates: x=${note.position.x}, y=${note.position.y}`);
  }
  
  return {
    type: DrawingObjectType.NOTE,
    note: {
      position: {
        type: 'Onshape::Reference::Point',
        coordinate: [x, y, 0]
      },
      contents: note.contents,
      textHeight: textHeight
    }
  };
}

interface OnshapeDimensionDiameter {
  type: typeof DrawingObjectType.DIMENSION_DIAMETER;
  diametricDimension: {
    chordPoint: {
      coordinate: number[];
      type: 'Onshape::Reference::Point';
      uniqueId: string;
      viewId: string;
      snapPointType: typeof SnapPointType.ModeNear;
    };
    farChordPoint: {
      coordinate: number[];
      type: 'Onshape::Reference::Point';
      uniqueId: string;
      viewId: string;
      snapPointType: typeof SnapPointType.ModeNear;
    };
    formatting: {
      dimdec: number;
      dimlim: boolean;
      dimpost: string;
      dimtm: number;
      dimtol: boolean;
      dimtp: number;
      type: 'Onshape::Formatting::Dimension';
    };
    textOverride: string;
    textPosition: {
      coordinate: number[];
      type: 'Onshape::Reference::Point';
    };
  };
}

function convertDrafterDimensionDiameterToOnshape(
  dimension: ProcessedDiameterDimension
): OnshapeDimensionDiameter {
  return {
    type: DrawingObjectType.DIMENSION_DIAMETER,
    diametricDimension: {
      chordPoint: {
        coordinate: dimension.chordPoint,
        type: 'Onshape::Reference::Point',
        uniqueId: dimension.uniqueId,
        viewId: dimension.viewId,
        snapPointType: SnapPointType.ModeNear
      },
      farChordPoint: {
        coordinate: dimension.farChordPoint,
        type: 'Onshape::Reference::Point',
        uniqueId: dimension.uniqueId,
        viewId: dimension.viewId,
        snapPointType: SnapPointType.ModeNear
      },
      formatting: {
        dimdec: 2,
        dimlim: false,
        dimpost: 'R<>',
        dimtm: 0,
        dimtol: false,
        dimtp: 0,
        type: 'Onshape::Formatting::Dimension'
      },
      textOverride: '',
      textPosition: {
        coordinate: dimension.textLocation,
        type: 'Onshape::Reference::Point'
      }
    }
  };
}

function processDrafterDimensionDiameter(
  dimension: DrafterDiameterDimension,
  viewGeometry: GetViewJsonGeometryResponse,
  view: View2
): ProcessedDiameterDimension {
  // Find the edge with matching deterministicId
  const edge = viewGeometry.bodyData.find(edge => edge.deterministicId === dimension.deterministicId);
  if (!edge || edge.type !== 'circle') {
    throw new Error(`No valid circle edge found for deterministicId: ${dimension.deterministicId}`);
  }
  if (!edge.data.center) {
    throw new Error('Center point is undefined');
  }
  if (!edge.data.radius) {
    throw new Error('Radius is undefined');
  }
  const centerPoint = edge.data.center;
  const chordPoint = pointOnCircle(centerPoint, edge.data.radius, 45.0);
  const farChordPoint = pointOnCircle(centerPoint, edge.data.radius, 225.0);

  // Locate text out from chord point by a bit
  const textLocation = [
    chordPoint[0] + (chordPoint[0] - centerPoint[0]),
    chordPoint[2],
    centerPoint[2]
  ];
  const paperTextLocation = convertPointViewToPaper(textLocation, view.viewToPaperMatrix.items);

  return {
    uniqueId: edge.uniqueId,
    viewId: view.viewId,
    chordPoint: chordPoint,
    farChordPoint: farChordPoint,
    textLocation: paperTextLocation
  };
}

async function applyAnnotations(apiClient: ApiClient, drawingScriptArgs: DrawingScriptArgs) {
  try {
    LOG.info(`documentId=${drawingScriptArgs.documentId}, workspaceId=${drawingScriptArgs.workspaceId}, elementId=${drawingScriptArgs.elementId}`);
  
    // Read the drafterData.json file
    const dataPath = path.join(process.cwd(), 'drafter/drafterData.json');
    const data: DrafterData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

    let drawingJsonExport: GetDrawingJsonExportResponse = await getDrawingJsonExport(apiClient, drawingScriptArgs.documentId, 'w', drawingScriptArgs.workspaceId, drawingScriptArgs.elementId) as GetDrawingJsonExportResponse;
    const views = getAllViewsOnActiveSheetFromExportData(drawingJsonExport);
    const textHeight = 0.12;
    
    // Process all elements
    const annotations = await Promise.all(data.elements.map(async (element: DrafterElement) => {
      if (isDrafterNote(element)) {
        return [convertDrafterNoteToOnshape(element, textHeight)];
      }
      if (isDrafterDiameterDimension(element)) {
        // Find all matching edges across all views
        const processedDimensions: ProcessedDiameterDimension[] = [];
        
        for (const view of views) {
          const viewGeometry = await apiClient.get(`api/appelements/d/${drawingScriptArgs.documentId}/w/${drawingScriptArgs.workspaceId}/e/${drawingScriptArgs.elementId}/views/${view.viewId}/jsongeometry`) as GetViewJsonGeometryResponse;
          
          try {
            const processedDimension = processDrafterDimensionDiameter(element, viewGeometry, view);
            processedDimensions.push(processedDimension);
          } catch (error) {
            // Skip if no matching edge found in this view
            continue;
          }
        }
        
        // Convert all processed dimensions to Onshape format and flatten
        return processedDimensions.flatMap(dim => convertDrafterDimensionDiameterToOnshape(dim));
      }
      LOG.warn(`Unsupported element type: ${element.type}`);
      return [];
    }));

    const flattenedAnnotations = annotations.flat();

    const requestBody = {
      description: 'Drafter annotations',
      jsonRequests: [
        {
          messageName: 'onshapeCreateAnnotations',
          formatVersion: '2021-01-01',
          annotations: flattenedAnnotations
        }
      ]
    };

    const modifyRequest = await apiClient.post(`api/v6/drawings/d/${drawingScriptArgs.documentId}/w/${drawingScriptArgs.workspaceId}/e/${drawingScriptArgs.elementId}/modify`, requestBody) as BasicNode;
  
    const responseOutput: ModifyStatusResponseOutput = await waitForModifyToFinish(apiClient, modifyRequest.id);
    if (responseOutput) {
      // Verify all requests succeeded
      const allSucceeded = responseOutput.results.every(result => 
        result.status === SingleRequestResultStatus.RequestSuccess
      );
      
      if (allSucceeded) {
        console.log(`Successfully created ${responseOutput.results.length} notes`);
        responseOutput.results.forEach((result, index) => {
          console.log(`Note ${index + 1} has logicalId: ${result.logicalId}`);
        });
      } else {
        console.log(`Some notes failed to create. Response status code: ${responseOutput.statusCode}.`);
      }
    } else {
      console.log('Create notes failed waiting for modify to finish.');
      LOG.info('Create notes failed waiting for modify to finish.');
    }
  } catch (error) {
    console.error(error);
    LOG.error('Create notes failed', error);
  }
}

const LOG = mainLog();

let drawingScriptArgs: DrawingScriptArgs;
let validArgs: boolean = true;
let apiClient: ApiClient;

try {
  drawingScriptArgs = parseDrawingScriptArgs();
  apiClient = await ApiClient.createApiClient(drawingScriptArgs.stackToUse);
  validateBaseURLs(apiClient.getBaseURL(), drawingScriptArgs.baseURL);
  applyAnnotations(apiClient, drawingScriptArgs);
} catch (error) {
  validArgs = false;
  usage('drafter');
}