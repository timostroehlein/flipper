/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the LICENSE
 * file in the root directory of this source tree.
 */
package com.facebook.flipper.plugins.sections;

import android.annotation.SuppressLint;
import com.facebook.flipper.core.FlipperArray;
import com.facebook.flipper.core.FlipperObject;
import com.facebook.litho.sections.Change;
import com.facebook.litho.sections.ChangesInfo;
import com.facebook.litho.sections.ChangesetDebugConfiguration;
import com.facebook.litho.sections.ChangesetDebugConfiguration.ChangesetDebugListener;
import com.facebook.litho.sections.Section;
import com.facebook.litho.sections.SectionsLogEventUtils;
import com.facebook.litho.sections.SectionsLogEventUtils.ApplyNewChangeSet;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

public class ChangesetDebug implements ChangesetDebugListener {

  private static ChangesetListener sSectionsFlipperPlugin;
  private static ChangesetDebug sInstance;
  private static AtomicInteger sChangesetIdGenerator = new AtomicInteger();

  public interface ChangesetListener {
    void onChangesetApplied(
        String name,
        boolean isAsync,
        String surfaceId,
        String id,
        FlipperArray tree,
        FlipperObject changesetData);
  }

  public static void setListener(ChangesetListener listener) {
    if (sInstance == null) {
      sInstance = new ChangesetDebug(listener);
      ChangesetDebugConfiguration.setListener(sInstance);
    }
  }

  private ChangesetDebug(ChangesetListener listener) {
    sSectionsFlipperPlugin = listener;
  }

  @Override
  public void onChangesetApplied(
      Section rootSection,
      Section oldRootSection,
      ChangesInfo changesInfo,
      String surfaceId,
      @ApplyNewChangeSet int attribution,
      String extra) {
    final FlipperArray.Builder tree = new FlipperArray.Builder();
    final FlipperObject.Builder changesetData = new FlipperObject.Builder();

    final String sourceName = SectionsLogEventUtils.applyNewChangeSetSourceToString(attribution);

    extractSidePanelChangesetData(changesInfo, changesetData, rootSection.getGlobalKey());

    createSectionTree(rootSection, tree, oldRootSection);

    List<DataModelChangeInfo> prevData = getDataFromPreviousTree(oldRootSection);
    applyChangesInfoOnPreviousData(prevData, changesInfo, tree);

    sSectionsFlipperPlugin.onChangesetApplied(
        sourceName + " " + extra,
        isEventAsync(attribution),
        surfaceId,
        sChangesetIdGenerator.incrementAndGet() + "-" + surfaceId,
        tree.build(),
        changesetData.build());
  }

  private static boolean isEventAsync(@ApplyNewChangeSet int source) {
    switch (source) {
      case ApplyNewChangeSet.SET_ROOT_ASYNC:
      case ApplyNewChangeSet.UPDATE_STATE_ASYNC:
        return true;
      default:
        return false;
    }
  }

  /** Extract the changesets for this section tree. */
  private static void extractSidePanelChangesetData(
      ChangesInfo changesInfo, FlipperObject.Builder changesetData, String globalKey) {
    final FlipperObject.Builder sectionChangesetInfo = new FlipperObject.Builder();

    final List<Change> changeList = changesInfo.getAllChanges();

    final FlipperObject.Builder changesets = new FlipperObject.Builder();
    for (int i = 0; i < changeList.size(); i++) {
      final Change change = changeList.get(i);
      final FlipperObject.Builder changeData = new FlipperObject.Builder();
      changeData.put("type", Change.changeTypeToString(change.getType()));
      changeData.put("index", change.getIndex());
      if (change.getToIndex() >= 0) {
        changeData.put("toIndex", change.getToIndex());
      }

      changeData.put("count", change.getCount());

      changeData.put("render_infos", ChangesetDebugConfiguration.getRenderInfoNames(change));

      changeData.put("prev_data", getDataNamesFromChange(change.getPrevData()));

      changeData.put("next_data", getDataNamesFromChange(change.getNextData()));

      changesets.put(i + "", changeData.build());
    }
    sectionChangesetInfo.put("changesets", changesets.build());

    changesetData.put(globalKey, sectionChangesetInfo.build());
  }

  private static List<String> getDataNamesFromChange(List<?> data) {
    final List<String> names = new ArrayList<>();

    if (data == null) {
      return names;
    }

    for (int i = 0; i < data.size(); i++) {
      names.add(data.get(i).toString());
    }

    return names;
  }

  /** Finds the section with the same global key in the previous tree, if it existed. */
  private static Section findSectionInPreviousTree(Section previousRoot, String globalKey) {
    if (previousRoot == null) {
      return null;
    }

    if (previousRoot.getGlobalKey().equals(globalKey)) {
      return previousRoot;
    }

    if (previousRoot.getChildren() == null) {
      return null;
    }

    int count = previousRoot.getChildren().size();
    for (int i = 0; i < count; i++) {
      Section child = previousRoot.getChildren().get(i);
      final Section previousSection = findSectionInPreviousTree(child, globalKey);

      if (previousSection != null) {
        return previousSection;
      }
    }

    return null;
  }

  /** Represents a data model node in a DiffSection. */
  private static class DataModelChangeInfo {
    static final int UNCHANGED = -100;
    Object model;
    int operation = UNCHANGED;
    String sectionKey;
  }

  /**
   * Skips all nodes which have been removed and finds the item on which the Change operation with
   * the given index is applied on.
   */
  private static int getPositionWithChangesApplied(
      List<DataModelChangeInfo> dataInfos, int operationIndex) {
    int count = -1;
    int i = 0;
    int size = dataInfos.size();
    for (i = 0; i < size; i++) {
      if (dataInfos.get(i).operation != Change.DELETE
          && dataInfos.get(i).operation != Change.DELETE_RANGE) {
        count++;
      }

      if (count == operationIndex) {
        break;
      }
    }

    return i;
  }

  /** For a given DiffSectionSpec section, returns the list of data on which it performs diffing. */
  private static List getDataFromPreviousSection(Section previousSection) {
    List data = new ArrayList();

    if (previousSection == null) {
      return data;
    }

    Class clasz = previousSection.getClass();
    final String diffSectionType = clasz.getSimpleName();

    try {
      if (diffSectionType.equals("DataDiffSection")) {
        Field field = clasz.getDeclaredField("data");
        field.setAccessible(true);
        data = (List) field.get(previousSection);
      } else if (diffSectionType.equals("SingleComponentSection")) {
        Field field = clasz.getDeclaredField("component");
        field.setAccessible(true);
        data.add(field.get(previousSection));
      }
    } catch (@SuppressLint("NewApi") NoSuchFieldException | IllegalAccessException e) {
      e.printStackTrace();
    }

    return data;
  }

  private static void addRemovedSectionNodes(
      Section previousRoot, Section currentRoot, final FlipperArray.Builder tree) {
    final Map<String, Section> prevSections = serializeChildren(previousRoot);
    final Map<String, Section> currSections = serializeChildren(currentRoot);

    for (String prevSectionKey : prevSections.keySet()) {
      if (!currSections.containsKey(prevSectionKey)) {
        final FlipperObject.Builder nodeBuilder = new FlipperObject.Builder();
        final Section section = prevSections.get(prevSectionKey);
        nodeBuilder.put("identifier", prevSectionKey);
        nodeBuilder.put("name", section.getSimpleName());
        nodeBuilder.put(
            "parent", section.getParent() == null ? null : section.getParent().getGlobalKey());
        nodeBuilder.put("removed", true);
        tree.put(nodeBuilder.build());
      }
    }
  }

  private static Map<String, Section> serializeChildren(Section root) {
    final Map<String, Section> children = new HashMap<>();
    serializeChildrenRecursive(root, children);

    return children;
  }

  private static void serializeChildrenRecursive(Section root, Map<String, Section> children) {
    if (root == null) {
      return;
    }

    children.put(root.getGlobalKey(), root);

    if (root.getChildren() == null) {
      return;
    }

    for (Section child : root.getChildren()) {
      serializeChildrenRecursive(child, children);
    }
  }

  private static List<DataModelChangeInfo> getDataFromPreviousTree(Section previousRoot) {
    final List<DataModelChangeInfo> dataModelChangeInfos = new ArrayList<>();

    getDataFromPreviousTreeRecursive(previousRoot, dataModelChangeInfos);

    return dataModelChangeInfos;
  }

  private static void getDataFromPreviousTreeRecursive(
      Section previousRoot, List<DataModelChangeInfo> data) {
    if (previousRoot == null) {
      return;
    }

    if (previousRoot.isDiffSectionSpec()) {
      List models = getDataFromPreviousSection(previousRoot);
      for (int i = 0; i < models.size(); i++) {
        DataModelChangeInfo dataModelChangeInfo = new DataModelChangeInfo();
        dataModelChangeInfo.model = models.get(i);
        dataModelChangeInfo.sectionKey = previousRoot.getGlobalKey();
        data.add(dataModelChangeInfo);
      }
    } else if (previousRoot.getChildren() != null) {
      for (Section child : previousRoot.getChildren()) {
        getDataFromPreviousTreeRecursive(child, data);
      }
    }
  }

  private static void applyChangesInfoOnPreviousData(
      List<DataModelChangeInfo> dataInfos, ChangesInfo changesInfo, FlipperArray.Builder tree) {
    final List<Change> changes = changesInfo.getAllChanges();

    for (int i = 0; i < changes.size(); i++) {
      final Change change = changes.get(i);
      int index = change.getIndex();

      switch (change.getType()) {
        case Change.INSERT:
          {
            DataModelChangeInfo dataInfo = new DataModelChangeInfo();
            if (change.getNextData() != null) {
              dataInfo.model = change.getNextData().get(0);
            }
            dataInfo.sectionKey =
                (String) change.getRenderInfo().getDebugInfo("section_global_key");

            dataInfo.operation = Change.INSERT;

            int addToPosition = getPositionWithChangesApplied(dataInfos, index);
            dataInfos.add(addToPosition, dataInfo);
            break;
          }
        case Change.INSERT_RANGE:
          {
            int addToPosition = getPositionWithChangesApplied(dataInfos, index);
            for (int item = 0; item < change.getCount(); item++) {
              DataModelChangeInfo dataInfo = new DataModelChangeInfo();
              if (change.getNextData() != null) {
                dataInfo.model = change.getNextData().get(item);
              }
              dataInfo.operation = Change.INSERT_RANGE;
              dataInfo.sectionKey =
                  (String) change.getRenderInfos().get(item).getDebugInfo("section_global_key");
              dataInfos.add(addToPosition + item, dataInfo);
            }
            break;
          }
        case Change.DELETE:
          {
            int addToPosition = getPositionWithChangesApplied(dataInfos, index);
            DataModelChangeInfo dataInfo = dataInfos.get(addToPosition);
            dataInfo.operation = Change.DELETE;
            break;
          }
        case Change.DELETE_RANGE:
          {
            int addToPosition = getPositionWithChangesApplied(dataInfos, index);
            for (int del = addToPosition; del < addToPosition + change.getCount(); del++) {
              dataInfos.get(del).operation = Change.DELETE_RANGE;
            }
            break;
          }
        case Change.UPDATE:
          {
            int getPosition = getPositionWithChangesApplied(dataInfos, index);
            dataInfos.get(getPosition).operation = Change.UPDATE;
            break;
          }
        case Change.UPDATE_RANGE:
          {
            for (int updateIndex = index; updateIndex < index + change.getCount(); updateIndex++) {
              int getPosition = getPositionWithChangesApplied(dataInfos, updateIndex);
              dataInfos.get(getPosition).operation = Change.UPDATE_RANGE;
            }
            break;
          }
        default:
          break;
      }
    }

    for (int i = 0; i < dataInfos.size(); i++) {

      DataModelChangeInfo dataInfo = dataInfos.get(i);
      final FlipperObject.Builder dataObject = new FlipperObject.Builder();

      String name = dataInfo.model == null ? "N/A" : dataInfo.model.toString();
      int operation = dataInfo.operation;

      dataObject.put("identifier", name);
      dataObject.put("name", name);
      dataObject.put("parent", dataInfo.sectionKey);
      dataObject.put("unchanged", operation == DataModelChangeInfo.UNCHANGED);
      dataObject.put("inserted", operation == Change.INSERT || operation == Change.INSERT_RANGE);
      dataObject.put("removed", operation == Change.DELETE || operation == Change.DELETE_RANGE);
      dataObject.put("updated", operation == Change.UPDATE || operation == Change.UPDATE_RANGE);
      tree.put(dataObject.build());
    }
  }

  private static void createSectionTree(
      Section rootSection, FlipperArray.Builder tree, Section oldRootSection) {
    createSectionTreeRecursive(rootSection, "", tree, oldRootSection);
    addRemovedSectionNodes(oldRootSection, rootSection, tree);
  }

  private static void createSectionTreeRecursive(
      Section rootSection, String parentKey, FlipperArray.Builder tree, Section oldRootSection) {
    if (rootSection == null) {
      return;
    }

    final String globalKey = rootSection.getGlobalKey();
    final FlipperObject.Builder nodeBuilder = new FlipperObject.Builder();

    final Section oldSection = findSectionInPreviousTree(oldRootSection, globalKey);
    final boolean isDirty = ChangesetDebugConfiguration.isSectionDirty(oldSection, rootSection);

    nodeBuilder.put("identifier", globalKey);
    nodeBuilder.put("name", rootSection.getSimpleName());
    nodeBuilder.put("parent", parentKey);
    nodeBuilder.put("isDirty", isDirty);
    nodeBuilder.put("isReused", !isDirty);
    nodeBuilder.put("didTriggerStateUpdate", false); // TODO
    tree.put(nodeBuilder.build());

    if (rootSection.getChildren() == null) {
      return;
    }

    for (int i = 0; i < rootSection.getChildren().size(); i++) {
      createSectionTreeRecursive(rootSection.getChildren().get(i), globalKey, tree, oldRootSection);
    }
  }
}
